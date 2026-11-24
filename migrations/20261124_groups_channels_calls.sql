-- TheAppleBook: groups and channels foundation
-- Run once in Supabase Dashboard -> SQL Editor.
-- Requires public.profiles(id) referencing auth.users(id).

create extension if not exists pgcrypto;

-- =========================
-- GROUPS
-- =========================
create table if not exists public.chat_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 500),
  avatar_url text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_group_members (
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.chat_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 5000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create index if not exists chat_groups_created_idx on public.chat_groups(created_at desc);
create index if not exists chat_group_members_user_idx on public.chat_group_members(user_id, joined_at desc);
create index if not exists chat_group_messages_group_idx on public.chat_group_messages(group_id, created_at desc);

-- =========================
-- CHANNELS
-- =========================
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 1000),
  avatar_url text,
  visibility text not null default 'public' check (visibility in ('public','private')),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'subscriber' check (member_role in ('owner','admin','subscriber')),
  joined_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists public.channel_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 10000),
  views_count bigint not null default 0 check (views_count >= 0),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create index if not exists channels_created_idx on public.channels(created_at desc);
create index if not exists channel_members_user_idx on public.channel_members(user_id, joined_at desc);
create index if not exists channel_posts_channel_idx on public.channel_posts(channel_id, created_at desc);

-- =========================
-- SECURITY HELPERS
-- =========================
create or replace function public.is_group_member(target_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_group_members m
    where m.group_id = target_group and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_group_admin(target_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_group_members m
    where m.group_id = target_group and m.user_id = (select auth.uid())
      and m.member_role in ('owner','admin')
  );
$$;

create or replace function public.is_channel_member(target_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.channel_members m
    where m.channel_id = target_channel and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_channel_admin(target_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.channel_members m
    where m.channel_id = target_channel and m.user_id = (select auth.uid())
      and m.member_role in ('owner','admin')
  );
$$;

revoke all on function public.is_group_member(uuid) from public, anon;
revoke all on function public.is_group_admin(uuid) from public, anon;
revoke all on function public.is_channel_member(uuid) from public, anon;
revoke all on function public.is_channel_admin(uuid) from public, anon;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_admin(uuid) to authenticated;
grant execute on function public.is_channel_member(uuid) to authenticated;
grant execute on function public.is_channel_admin(uuid) to authenticated;

-- =========================
-- CREATE RPCs
-- =========================
create or replace function public.create_chat_group(
  group_name text,
  group_description text default '',
  group_avatar_url text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(group_name,''))) not between 2 and 60 then
    raise exception 'Group name must contain 2-60 characters';
  end if;
  insert into public.chat_groups(name, description, avatar_url, created_by)
  values (trim(group_name), coalesce(group_description,''), group_avatar_url, auth.uid())
  returning id into new_id;
  insert into public.chat_group_members(group_id,user_id,member_role)
  values (new_id, auth.uid(), 'owner');
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
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(channel_name,''))) not between 2 and 60 then
    raise exception 'Channel name must contain 2-60 characters';
  end if;
  if channel_visibility not in ('public','private') then
    raise exception 'Invalid channel visibility';
  end if;
  insert into public.channels(name,description,visibility,avatar_url,created_by)
  values (trim(channel_name),coalesce(channel_description,''),channel_visibility,channel_avatar_url,auth.uid())
  returning id into new_id;
  insert into public.channel_members(channel_id,user_id,member_role)
  values (new_id,auth.uid(),'owner');
  return new_id;
end;
$$;

revoke all on function public.create_chat_group(text,text,text) from public, anon;
revoke all on function public.create_channel(text,text,text,text) from public, anon;
grant execute on function public.create_chat_group(text,text,text) to authenticated;
grant execute on function public.create_channel(text,text,text,text) to authenticated;

-- =========================
-- RLS
-- =========================
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;
alter table public.chat_group_messages enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.channel_posts enable row level security;

-- Groups are visible only to their members.
drop policy if exists chat_groups_select_members on public.chat_groups;
create policy chat_groups_select_members on public.chat_groups for select to authenticated
using (public.is_group_member(id));

drop policy if exists chat_group_members_select_members on public.chat_group_members;
create policy chat_group_members_select_members on public.chat_group_members for select to authenticated
using (public.is_group_member(group_id));

drop policy if exists chat_group_members_admin_insert on public.chat_group_members;
create policy chat_group_members_admin_insert on public.chat_group_members for insert to authenticated
with check (public.is_group_admin(group_id));

drop policy if exists chat_group_members_admin_update on public.chat_group_members;
create policy chat_group_members_admin_update on public.chat_group_members for update to authenticated
using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));

drop policy if exists chat_group_members_admin_delete on public.chat_group_members;
create policy chat_group_members_admin_delete on public.chat_group_members for delete to authenticated
using (public.is_group_admin(group_id) and user_id <> (select auth.uid()));

drop policy if exists chat_group_messages_select_members on public.chat_group_messages;
create policy chat_group_messages_select_members on public.chat_group_messages for select to authenticated
using (public.is_group_member(group_id));

drop policy if exists chat_group_messages_insert_members on public.chat_group_messages;
create policy chat_group_messages_insert_members on public.chat_group_messages for insert to authenticated
with check (sender_id = (select auth.uid()) and public.is_group_member(group_id));

drop policy if exists chat_group_messages_update_own on public.chat_group_messages;
create policy chat_group_messages_update_own on public.chat_group_messages for update to authenticated
using (sender_id = (select auth.uid())) with check (sender_id = (select auth.uid()) and public.is_group_member(group_id));

-- Public channels can be discovered by signed-in users; private channels only by members.
drop policy if exists channels_select_visible on public.channels;
create policy channels_select_visible on public.channels for select to authenticated
using (visibility = 'public' or public.is_channel_member(id));

drop policy if exists channel_members_select_visible on public.channel_members;
create policy channel_members_select_visible on public.channel_members for select to authenticated
using (
  public.is_channel_member(channel_id) or exists (
    select 1 from public.channels c where c.id = channel_id and c.visibility = 'public'
  )
);

drop policy if exists channel_members_admin_insert on public.channel_members;
create policy channel_members_admin_insert on public.channel_members for insert to authenticated
with check (public.is_channel_admin(channel_id));

drop policy if exists channel_members_self_join_public on public.channel_members;
create policy channel_members_self_join_public on public.channel_members for insert to authenticated
with check (user_id = (select auth.uid()) and member_role = 'subscriber' and exists (
  select 1 from public.channels c where c.id = channel_id and c.visibility = 'public'
));

drop policy if exists channel_members_admin_delete on public.channel_members;
create policy channel_members_admin_delete on public.channel_members for delete to authenticated
using (public.is_channel_admin(channel_id) and user_id <> (select auth.uid()));

drop policy if exists channel_members_self_leave on public.channel_members;
create policy channel_members_self_leave on public.channel_members for delete to authenticated
using (user_id = (select auth.uid()) and member_role = 'subscriber');

drop policy if exists channel_posts_select_visible on public.channel_posts;
create policy channel_posts_select_visible on public.channel_posts for select to authenticated
using (
  public.is_channel_member(channel_id) or exists (
    select 1 from public.channels c where c.id = channel_id and c.visibility = 'public'
  )
);

drop policy if exists channel_posts_admin_insert on public.channel_posts;
create policy channel_posts_admin_insert on public.channel_posts for insert to authenticated
with check (author_id = (select auth.uid()) and public.is_channel_admin(channel_id));

drop policy if exists channel_posts_admin_update on public.channel_posts;
create policy channel_posts_admin_update on public.channel_posts for update to authenticated
using (public.is_channel_admin(channel_id)) with check (public.is_channel_admin(channel_id));

drop policy if exists channel_posts_admin_delete on public.channel_posts;
create policy channel_posts_admin_delete on public.channel_posts for delete to authenticated
using (public.is_channel_admin(channel_id));

-- Table grants (RLS remains the actual access control).
grant select on public.chat_groups, public.chat_group_members, public.chat_group_messages,
  public.channels, public.channel_members, public.channel_posts to authenticated;
grant insert, update, delete on public.chat_group_members to authenticated;
grant insert, select, update on public.chat_group_messages to authenticated;
grant insert, select, update, delete on public.channel_members to authenticated;
grant insert, select, update, delete on public.channel_posts to authenticated;

-- Enable Realtime for newly created message/post tables when publication exists.
do $$ begin
  alter publication supabase_realtime add table public.chat_group_messages;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.channel_posts;
exception when duplicate_object then null; when undefined_object then null; end $$;

