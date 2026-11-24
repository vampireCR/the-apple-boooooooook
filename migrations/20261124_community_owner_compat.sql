-- TheAppleBook: compatibility fix for legacy owner_id / created_by columns.
-- Safe to run repeatedly. Does not delete existing rows.
create extension if not exists pgcrypto;

-- Both legacy and current ownership names are supported. Some earlier schemas
-- used owner_id NOT NULL, while the new UI/RPC uses created_by.
alter table public.chat_groups add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
alter table public.chat_groups add column if not exists created_by uuid references public.profiles(id) on delete cascade;
alter table public.channels add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
alter table public.channels add column if not exists created_by uuid references public.profiles(id) on delete cascade;

-- Backfill both fields from whichever legacy field is already populated.
update public.chat_groups set owner_id = coalesce(owner_id, created_by), created_by = coalesce(created_by, owner_id)
where owner_id is null or created_by is null;
update public.channels set owner_id = coalesce(owner_id, created_by), created_by = coalesce(created_by, owner_id)
where owner_id is null or created_by is null;

-- Ensure the group/channel RPCs always satisfy either schema variant.
create or replace function public.create_chat_group(
  group_name text,
  group_description text default '',
  group_avatar_url text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(group_name,''))) not between 2 and 60 then raise exception 'Group name must contain 2-60 characters'; end if;
  insert into public.chat_groups(name, description, avatar_url, owner_id, created_by)
  values (trim(group_name), coalesce(group_description,''), group_avatar_url, actor, actor)
  returning id into new_id;
  insert into public.chat_group_members(group_id,user_id,member_role)
  values (new_id, actor, 'owner') on conflict (group_id,user_id) do update set member_role='owner';
  return new_id;
end;
$$;

create or replace function public.create_channel(
  channel_name text,
  channel_description text default '',
  channel_visibility text default 'public',
  channel_avatar_url text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(channel_name,''))) not between 2 and 60 then raise exception 'Channel name must contain 2-60 characters'; end if;
  if channel_visibility not in ('public','private') then raise exception 'Invalid channel visibility'; end if;
  insert into public.channels(name,description,visibility,avatar_url,owner_id,created_by)
  values (trim(channel_name),coalesce(channel_description,''),channel_visibility,channel_avatar_url,actor,actor)
  returning id into new_id;
  insert into public.channel_members(channel_id,user_id,member_role)
  values (new_id,actor,'owner') on conflict (channel_id,user_id) do update set member_role='owner';
  return new_id;
end;
$$;

create or replace function public.group_add_member(target_group uuid, target_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_admin(target_group) then raise exception 'Only group owner/admin can add members'; end if;
  if not exists(select 1 from public.profiles where id=target_user) then raise exception 'User not found'; end if;
  insert into public.chat_group_members(group_id,user_id,member_role)
  values(target_group,target_user,'member') on conflict(group_id,user_id) do nothing;
end;
$$;

create or replace function public.group_set_member_role(target_group uuid, target_user uuid, new_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_admin(target_group) then raise exception 'Only group owner/admin can manage roles'; end if;
  if new_role not in ('admin','member') then raise exception 'Invalid role'; end if;
  if exists(select 1 from public.chat_group_members where group_id=target_group and user_id=target_user and member_role='owner') then raise exception 'Owner role cannot be changed'; end if;
  update public.chat_group_members set member_role=new_role where group_id=target_group and user_id=target_user;
end;
$$;

create or replace function public.group_remove_member(target_group uuid, target_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_group_admin(target_group) then raise exception 'Only group owner/admin can remove members'; end if;
  if exists(select 1 from public.chat_group_members where group_id=target_group and user_id=target_user and member_role='owner') then raise exception 'Owner cannot be removed'; end if;
  delete from public.chat_group_members where group_id=target_group and user_id=target_user;
end;
$$;

revoke all on function public.create_chat_group(text,text,text) from public, anon;
revoke all on function public.create_channel(text,text,text,text) from public, anon;
revoke all on function public.group_add_member(uuid,uuid) from public, anon;
revoke all on function public.group_set_member_role(uuid,uuid,text) from public, anon;
revoke all on function public.group_remove_member(uuid,uuid) from public, anon;
grant execute on function public.create_chat_group(text,text,text) to authenticated;
grant execute on function public.create_channel(text,text,text,text) to authenticated;
grant execute on function public.group_add_member(uuid,uuid) to authenticated;
grant execute on function public.group_set_member_role(uuid,uuid,text) to authenticated;
grant execute on function public.group_remove_member(uuid,uuid) to authenticated;


create or replace function public.channel_add_member(target_channel uuid, target_user uuid, grant_admin boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_channel_admin(target_channel) then raise exception 'Only channel owner/admin can invite members'; end if;
  if not exists(select 1 from public.profiles where id=target_user) then raise exception 'User not found'; end if;
  insert into public.channel_members(channel_id,user_id,member_role)
  values(target_channel,target_user,case when grant_admin then 'admin' else 'subscriber' end)
  on conflict(channel_id,user_id) do update set member_role=excluded.member_role;
end;
$$;

create or replace function public.channel_remove_member(target_channel uuid, target_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_channel_admin(target_channel) then raise exception 'Only channel owner/admin can remove members'; end if;
  if exists(select 1 from public.channel_members where channel_id=target_channel and user_id=target_user and member_role='owner') then raise exception 'Owner cannot be removed'; end if;
  delete from public.channel_members where channel_id=target_channel and user_id=target_user;
end;
$$;

revoke all on function public.channel_add_member(uuid,uuid,boolean) from public, anon;
revoke all on function public.channel_remove_member(uuid,uuid) from public, anon;
grant execute on function public.channel_add_member(uuid,uuid,boolean) to authenticated;
grant execute on function public.channel_remove_member(uuid,uuid) to authenticated;

-- Lightweight per-user emoji reactions on group messages.
alter table public.chat_group_messages
  add column if not exists reactions jsonb not null default '{}'::jsonb;

create or replace function public.toggle_group_message_reaction(target_message uuid, reaction_emoji text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row_group uuid; current_reactions jsonb; people jsonb; uid text := (select auth.uid())::text;
begin
  if reaction_emoji not in ('👍','❤️','😂','🔥','👏') then raise exception 'Unsupported reaction'; end if;
  select group_id, coalesce(reactions,'{}'::jsonb) into row_group,current_reactions
  from public.chat_group_messages where id=target_message for update;
  if row_group is null then raise exception 'Message not found'; end if;
  if not public.is_group_member(row_group) then raise exception 'Not a group member'; end if;
  people := coalesce(current_reactions -> reaction_emoji, '[]'::jsonb);
  if people ? uid then
    select coalesce(jsonb_agg(value), '[]'::jsonb) into people from jsonb_array_elements(people) where value #>> '{}' <> uid;
  else
    people := people || jsonb_build_array(uid);
  end if;
  if jsonb_array_length(people)=0 then current_reactions := current_reactions - reaction_emoji;
  else current_reactions := jsonb_set(current_reactions, array[reaction_emoji], people, true);
  end if;
  update public.chat_group_messages set reactions=current_reactions where id=target_message;
  return current_reactions;
end;
$$;
revoke all on function public.toggle_group_message_reaction(uuid,text) from public, anon;
grant execute on function public.toggle_group_message_reaction(uuid,text) to authenticated;

-- Group attachments and voice-message metadata (files use the existing private message-files bucket).
create table if not exists public.chat_group_message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_group_messages(id) on delete cascade,
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  created_at timestamptz not null default now()
);
create index if not exists chat_group_attachments_message_idx on public.chat_group_message_attachments(message_id);
alter table public.chat_group_message_attachments enable row level security;
revoke all on public.chat_group_message_attachments from anon, authenticated;
grant select, insert, delete on public.chat_group_message_attachments to authenticated;
drop policy if exists group_attachment_select_members on public.chat_group_message_attachments;
create policy group_attachment_select_members on public.chat_group_message_attachments for select to authenticated
using (public.is_group_member(group_id));
drop policy if exists group_attachment_insert_sender on public.chat_group_message_attachments;
create policy group_attachment_insert_sender on public.chat_group_message_attachments for insert to authenticated
with check (sender_id=(select auth.uid()) and public.is_group_member(group_id));
drop policy if exists group_attachment_delete_sender on public.chat_group_message_attachments;
create policy group_attachment_delete_sender on public.chat_group_message_attachments for delete to authenticated
using (sender_id=(select auth.uid()));

drop policy if exists group_members_upload_message_files on storage.objects;
create policy group_members_upload_message_files on storage.objects for insert to authenticated
with check (bucket_id='message-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists group_members_read_message_files on storage.objects;
create policy group_members_read_message_files on storage.objects for select to authenticated
using (bucket_id='message-files' and exists (
  select 1 from public.chat_group_message_attachments a
  where a.storage_path=name and public.is_group_member(a.group_id)
));

create or replace function public.record_channel_post_views(target_channel uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.channels c where c.id=target_channel and (c.visibility='public' or public.is_channel_member(c.id))) then
    raise exception 'Channel is not visible';
  end if;
  update public.channel_posts set views_count=views_count+1 where channel_id=target_channel;
end;
$$;
revoke all on function public.record_channel_post_views(uuid) from public, anon;
grant execute on function public.record_channel_post_views(uuid) to authenticated;
