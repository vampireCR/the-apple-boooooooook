import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://tzkxujrjrhyqxgzytaex.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_BrNnF8XCshRm1NmEYvQphg_hcNIJhQV";

// Каждый браузер/устройство хранит собственную локальную сессию.
// Это позволяет входить в один аккаунт с нескольких устройств одновременно.
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  }
});
const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let currentPresenceMode = "online";
let activeChatUser = null;
let messagesChannel = null;
let searchTimer = null;
let bootRunning = false;
let sendingMessage = false;
let searchRequestId = 0;
let feedLoadPromise = null;
let giftLoadPromise = null;
const presenceCache = new Map();

// =====================================
// ОБЩИЕ ФУНКЦИИ
// =====================================

function say(message, target = "globalMessage") {
  const el = $(target);
  if (el) el.textContent = message || "";
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function roleLabel(role) {
  return ({
    owner: "OWNER",
    ceo: "CEO",
    deputy_ceo: "DEPUTY CEO",
    admin: "ADMIN",
    moderator: "MODERATOR",
    member: "MEMBER"
  })[role] || "MEMBER";
}

function isStaff(role) {
  return ["owner", "ceo", "deputy_ceo", "admin", "moderator"].includes(role);
}

function presenceLabel(mode) {
  return ({ online: "🟢 В сети", invisible: "⚫ Невидимый", sleep: "🌙 Спящий режим", hidden: "Присутствие скрыто" })[mode] || "Присутствие скрыто";
}

async function fillPresenceForProfiles(container, profiles) {
  const people = profiles || [];
  const now = Date.now();
  const missing = people.filter(person => {
    const cached = presenceCache.get(person.id);
    return !cached || cached.expiresAt <= now;
  });
  if (missing.length) {
    const { data, error } = await supabase.rpc("visible_presence_many", {
      target_users: missing.map(person => person.id)
    });
    const values = new Map((data || []).map(row => [row.user_id, row.presence_mode]));
    for (const person of missing) {
      presenceCache.set(person.id, {
        value: error ? "hidden" : (values.get(person.id) || "online"),
        expiresAt: Date.now() + 15000
      });
    }
  }
  for (const person of people) {
    const mode = presenceCache.get(person.id)?.value || "hidden";
    const target = container?.querySelector(`[data-presence-for="${CSS.escape(person.id)}"]`);
    if (target) target.textContent = presenceLabel(mode);
  }
}

function formatTime(date) {
  return new Date(date).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function avatarContent(profile) {
  if (profile?.avatar_url) {
    return `<img src="${esc(profile.avatar_url)}" alt="Аватар" loading="lazy">`;
  }

  return esc(
    profile?.avatar_emoji ||
    profile?.username?.slice(0, 1).toUpperCase() ||
    "?"
  );
}

function renderAvatar(profile, className = "user-avatar") {
  return `
    <div class="${className}">
      ${avatarContent(profile)}
    </div>
  `;
}

function renderAvatarButton(profile, className = "user-avatar") {
  if (!profile?.id) return renderAvatar(profile, className);

  return `
    <button
      type="button"
      class="avatar-profile-button"
      data-profile-open="${esc(profile.id)}"
      aria-label="Открыть профиль ${esc(profile.username || "пользователя")}"
      title="Открыть профиль"
    >
      ${renderAvatar(profile, className)}
    </button>
  `;
}

function profileHandle(profile) {
  return profile?.handle
    ? `@${esc(profile.handle)}`
    : "";
}

function profileLink(profile) {
  if (!profile?.id) return "";

  return `
    <button
      type="button"
      class="profile-open-link"
      data-profile-open="${esc(profile.id)}"
    >
      Открыть профиль
    </button>
  `;
}

async function removeMessagesChannel() {
  if (messagesChannel) {
    await supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }
}

// =====================================
// ПЕРЕКЛЮЧЕНИЕ СТРАНИЦ
// =====================================

function showPage(name) {
  document.querySelectorAll(".page").forEach(page => {
    page.classList.add("hidden");
  });

  $("page-" + name)?.classList.remove("hidden");

  document.querySelectorAll(".nav-btn[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === name);
  });

  if (name === "feed") loadFeed();
  if (name === "notes") loadNotes();
  if (name === "gifts") loadGiftShop();
  if (name === "people") searchPeople();
  if (name === "friends") loadFriends();
  if (name === "messages") loadMessageContacts();
  if (name === "contacts") loadContacts();
  if (name === "groups") loadCommunityPreview("groups");
  if (name === "channels") loadCommunityPreview("channels");
  if (name === "profile") renderProfile();
  if (name === "admin") loadAdmin();
  if (name === "settings") fillSettings();
}

document.querySelectorAll(".nav-btn[data-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.go));
});

// Выдвижная навигация: единая логика для desktop и mobile.
const menuToggle = $("menuToggle");
const menuBackdrop = $("menuBackdrop");
const appSidebar = document.querySelector("#appView .sidebar");
function closeAppMenu() {
  appSidebar?.classList.remove("menu-open");
  menuBackdrop?.classList.remove("visible");
  menuToggle?.setAttribute("aria-expanded", "false");
}
function toggleAppMenu() {
  const opened = appSidebar?.classList.toggle("menu-open") || false;
  menuBackdrop?.classList.toggle("visible", opened);
  menuToggle?.setAttribute("aria-expanded", String(opened));
}
menuToggle?.addEventListener("click", toggleAppMenu);
menuBackdrop?.addEventListener("click", closeAppMenu);
document.querySelectorAll(".nav-btn[data-page]").forEach(button => {
  button.addEventListener("click", closeAppMenu);
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeAppMenu(); });

// =====================================
// ГРУППЫ И КАНАЛЫ — РАБОЧИЕ CRUD-ПОТОКИ
// =====================================
let activeGroupId = null;
let activeChannelId = null;
let communityRealtime = null;

function communityMessage(target, text, isError = false) {
  if (!target) return;
  target.textContent = text;
  target.classList.toggle("error-text", isError);
}

async function createGroup() {
  if (!currentUser) return say("Сначала войди в аккаунт.");
  const name = prompt("Название группы (2–60 символов):");
  if (name === null) return;
  const cleanName = name.trim();
  if (cleanName.length < 2 || cleanName.length > 60) return say("Название должно содержать от 2 до 60 символов.");
  const description = prompt("Описание группы (необязательно):") ?? "";
  const avatar = prompt("URL фотографии группы (необязательно):") ?? "";
  const { data, error } = await supabase.rpc("create_chat_group", {
    group_name: cleanName,
    group_description: description.trim().slice(0, 500),
    group_avatar_url: avatar.trim() || null
  });
  if (error) return say("Не удалось создать группу: " + error.message);
  say("Группа создана.");
  await loadCommunityPreview("groups");
  if (data) openGroup(data);
}

async function createChannel() {
  if (!currentUser) return say("Сначала войди в аккаунт.");
  const name = prompt("Название канала (2–60 символов):");
  if (name === null) return;
  const cleanName = name.trim();
  if (cleanName.length < 2 || cleanName.length > 60) return say("Название должно содержать от 2 до 60 символов.");
  const description = prompt("Описание канала:") ?? "";
  const avatar = prompt("URL аватара канала (необязательно):") ?? "";
  const visibility = confirm("Сделать канал приватным? Нажми OK для приватного, Отмена для публичного.") ? "private" : "public";
  const { data, error } = await supabase.rpc("create_channel", {
    channel_name: cleanName,
    channel_description: description.trim().slice(0, 1000),
    channel_visibility: visibility,
    channel_avatar_url: avatar.trim() || null
  });
  if (error) return say("Не удалось создать канал: " + error.message);
  say("Канал создан.");
  await loadCommunityPreview("channels");
  if (data) openChannel(data);
}

$("createGroupButton")?.addEventListener("click", createGroup);
$("createChannelButton")?.addEventListener("click", createChannel);

function makeCommunityButton(label, action, className = "secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function loadCommunityPreview(kind) {
  const groups = kind === "groups";
  const target = $(groups ? "groupsList" : "channelsList");
  if (!target || !currentUser) return;
  target.innerHTML = '<p class="muted">Загрузка…</p>';
  let query = supabase.from(groups ? "chat_groups" : "channels")
    .select(groups ? "id,name,description,avatar_url,created_at" : "id,name,description,avatar_url,visibility,created_at")
    .order("created_at", { ascending: false }).limit(50);
  const { data, error } = await query;
  if (error) {
    target.innerHTML = `<p class="error-text">Не удалось загрузить раздел: ${esc(error.message)}</p>`;
    return;
  }
  target.replaceChildren();
  for (const item of data || []) {
    const card = document.createElement("article"); card.className = "community-card community-card-rich";
    const info = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = item.name;
    const desc = document.createElement("p"); desc.className = "muted"; desc.textContent = item.description || "Без описания";
    const meta = document.createElement("small"); meta.className = "muted";
    meta.textContent = groups ? "Групповая переписка" : (item.visibility === "private" ? "🔒 Приватный канал" : "🌐 Публичный канал");
    info.append(title, desc, meta);
    const actions = document.createElement("div"); actions.className = "community-actions";
    if (groups) actions.append(makeCommunityButton("Открыть чат", () => openGroup(item.id), "primary"));
    else actions.append(makeCommunityButton("Открыть", () => openChannel(item.id), "primary"));
    card.append(info, actions); target.append(card);
  }
  if (!data?.length) target.innerHTML = `<div class="community-empty"><strong>${groups ? "Пока нет групп" : "Пока нет каналов"}</strong><p class="muted">Создай первое пространство для общения.</p></div>`;
}

async function openGroup(groupId) {
  activeGroupId = groupId; activeChannelId = null;
  const target = $("groupsList");
  if (!target) return;
  const { data: group, error } = await supabase.from("chat_groups").select("id,name,description").eq("id", groupId).single();
  if (error) return say("Не удалось открыть группу: " + error.message);
  target.innerHTML = `<div class="community-chat"><div class="community-chat-head"><button id="groupBack" class="secondary">← Группы</button><div><h2>${esc(group.name)}</h2><p class="muted">${esc(group.description || "Групповой чат")}</p></div><button id="groupMembersButton" class="secondary">Участники</button></div><div id="groupMessages" class="community-messages">Загрузка сообщений…</div><form id="groupMessageForm" class="community-compose"><input id="groupMessageInput" maxlength="5000" placeholder="Написать сообщение…"><button class="primary">Отправить</button><label class="group-file-label" for="groupFileInput">📎 Файл</label><input id="groupFileInput" class="hidden" type="file" accept="image/*,video/mp4,video/webm,audio/webm,audio/mp4,application/pdf,text/plain"></form><button id="groupVoiceButton" class="secondary" type="button">🎙 Записать голосовое</button><p id="groupNotice" class="notice" aria-live="polite"></p></div>`;
  $("groupBack")?.addEventListener("click", () => loadCommunityPreview("groups"));
  $("groupMessageForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const input = $("groupMessageInput"); const content = input.value.trim(); if (!content) return;
    const { error: sendError } = await supabase.from("chat_group_messages").insert({ group_id: groupId, sender_id: currentUser.id, content });
    if (sendError) communityMessage($("groupNotice"), sendError.message, true); else { input.value = ""; await loadGroupMessages(groupId); }
  });
  $("groupMembersButton")?.addEventListener("click", () => manageGroupMembers(groupId));
  $("groupFileInput")?.addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (file) await uploadGroupAttachment(groupId, file, false);
    event.target.value = "";
  });
  $("groupVoiceButton")?.addEventListener("click", toggleGroupVoiceRecording);
  await loadGroupMessages(groupId);
  if (communityRealtime) await supabase.removeChannel(communityRealtime);
  communityRealtime = supabase.channel("group-chat-" + groupId).on("postgres_changes", { event: "*", schema: "public", table: "chat_group_messages", filter: "group_id=eq." + groupId }, () => loadGroupMessages(groupId)).subscribe();
}

async function loadGroupMessages(groupId) {
  const target = $("groupMessages"); if (!target) return;
  const { data, error } = await supabase.from("chat_group_messages").select("id,content,sender_id,created_at,reactions").eq("group_id", groupId).order("created_at", { ascending: true }).limit(200);
  if (error) { target.textContent = "Не удалось загрузить сообщения: " + error.message; return; }
  const senderIds = [...new Set((data || []).map(row => row.sender_id))];
  const { data: profiles } = senderIds.length ? await supabase.from("profiles").select("id,username").in("id", senderIds) : { data: [] };
  const names = new Map((profiles || []).map(profile => [profile.id, profile.username]));
  const messageIds = (data || []).map(row => row.id);
  const { data: attachmentRows } = messageIds.length ? await supabase.from("chat_group_message_attachments").select("message_id,storage_path,file_name,mime_type").in("message_id", messageIds) : { data: [] };
  const attachmentMap = new Map();
  for (const attachment of attachmentRows || []) {
    const { data: signed } = await supabase.storage.from("message-files").createSignedUrl(attachment.storage_path, 3600);
    const list = attachmentMap.get(attachment.message_id) || [];
    list.push({ ...attachment, url: signed?.signedUrl }); attachmentMap.set(attachment.message_id, list);
  }
  target.replaceChildren();
  for (const msg of data || []) {
    const row = document.createElement("article"); row.className = "community-message";
    const author = document.createElement("strong"); author.textContent = names.get(msg.sender_id) || (msg.sender_id === currentUser.id ? "Вы" : "Участник");
    const body = document.createElement("p"); body.textContent = msg.content;
    const time = document.createElement("small"); time.textContent = formatTime(msg.created_at);
    const reactions = document.createElement("div"); reactions.className = "group-reactions";
    for (const emoji of ["👍", "❤️", "😂", "🔥", "👏"]) {
      const count = msg.reactions?.[emoji]?.length || 0;
      const reaction = makeCommunityButton(`${emoji} ${count || ""}`, async () => {
        const { error: reactionError } = await supabase.rpc("toggle_group_message_reaction", { target_message: msg.id, reaction_emoji: emoji });
        if (reactionError) say("Не удалось поставить реакцию: " + reactionError.message); else await loadGroupMessages(groupId);
      }, "secondary");
      reaction.classList.toggle("reaction-active", (msg.reactions?.[emoji] || []).includes(currentUser.id));
      reactions.append(reaction);
    }
    row.append(author, body);
    for (const attachment of attachmentMap.get(msg.id) || []) {
      if (!attachment.url) continue;
      if (attachment.mime_type.startsWith("audio/")) {
        const audio = document.createElement("audio"); audio.controls = true; audio.src = attachment.url; audio.className = "group-audio"; row.append(audio);
      } else {
        const link = document.createElement("a"); link.href = attachment.url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "📎 " + attachment.file_name; row.append(link);
      }
    }
    row.append(time, reactions); target.append(row);
  }
  target.scrollTop = target.scrollHeight;
}

async function uploadGroupAttachment(groupId, file, isVoice) {
  const mime = (file.type || "application/octet-stream").split(";")[0].toLowerCase();
  const allowed = ["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","audio/webm","audio/mp4","application/pdf","text/plain"];
  if (!allowed.includes(mime)) return communityMessage($("groupNotice"), "Этот тип файла не поддерживается.", true);
  if (!file.size || file.size > 10 * 1024 * 1024) return communityMessage($("groupNotice"), "Файл должен быть не больше 10 МБ.", true);
  const messageId = crypto.randomUUID();
  const safeName = (file.name || (isVoice ? "voice-message.webm" : "attachment")).replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 120);
  const storagePath = `${currentUser.id}/${groupId}/${messageId}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("message-files").upload(storagePath, file, { contentType: mime, upsert: false });
  if (uploadError) return communityMessage($("groupNotice"), "Ошибка загрузки: " + uploadError.message, true);
  const { error: messageError } = await supabase.from("chat_group_messages").insert({ id: messageId, group_id: groupId, sender_id: currentUser.id, content: isVoice ? "Голосовое сообщение" : `Вложение: ${safeName}` });
  if (messageError) { await supabase.storage.from("message-files").remove([storagePath]); return communityMessage($("groupNotice"), messageError.message, true); }
  const { error: metaError } = await supabase.from("chat_group_message_attachments").insert({ message_id: messageId, group_id: groupId, sender_id: currentUser.id, storage_path: storagePath, file_name: safeName, mime_type: mime, file_size: file.size });
  if (metaError) communityMessage($("groupNotice"), "Сообщение отправлено, но вложение не прикрепилось: " + metaError.message, true);
  else communityMessage($("groupNotice"), isVoice ? "Голосовое отправлено." : "Файл отправлен.");
  await loadGroupMessages(groupId);
}

let groupRecorder = null;
let groupRecorderStream = null;
async function toggleGroupVoiceRecording() {
  const button = $("groupVoiceButton");
  if (groupRecorder && groupRecorder.state === "recording") { groupRecorder.stop(); if (button) button.textContent = "🎙 Записать голосовое"; return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return communityMessage($("groupNotice"), "Запись аудио не поддерживается этим браузером.", true);
  try {
    groupRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    groupRecorder = new MediaRecorder(groupRecorderStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    groupRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    groupRecorder.onstop = async () => {
      groupRecorderStream?.getTracks().forEach(track => track.stop()); groupRecorderStream = null;
      const blob = new Blob(chunks, { type: groupRecorder.mimeType || "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
      if (activeGroupId) await uploadGroupAttachment(activeGroupId, file, true);
    };
    groupRecorder.start();
    if (button) button.textContent = "⏹ Остановить и отправить";
    communityMessage($("groupNotice"), "Идёт запись голосового сообщения… Нажми кнопку ещё раз, чтобы отправить.");
  } catch (error) { groupRecorderStream?.getTracks().forEach(track => track.stop()); groupRecorderStream = null; communityMessage($("groupNotice"), "Нет доступа к микрофону: " + error.message, true); }
}

async function manageGroupMembers(groupId) {
  const { data, error } = await supabase.from("chat_group_members").select("user_id,member_role").eq("group_id", groupId);
  if (error) return say("Не удалось получить участников: " + error.message);
  const memberIds = (data || []).map(member => member.user_id);
  const { data: profiles } = memberIds.length ? await supabase.from("profiles").select("id,username").in("id", memberIds) : { data: [] };
  const names = new Map((profiles || []).map(profile => [profile.id, profile.username]));
  const lines = (data || []).map((m, i) => `${i + 1}. ${names.get(m.user_id) || m.user_id} — ${m.member_role}`).join("\n");
  const choice = prompt("Участники группы:\n" + (lines || "Пока нет участников") + "\n\nВведи ник для добавления или номер участника для управления:");
  if (!choice) return;
  if (/^\d+$/.test(choice.trim())) {
    const member = data[Number(choice) - 1];
    if (!member) return say("Такого номера нет.");
    if (member.member_role === "owner") return say("Владелец группы защищён от изменения роли и удаления.");
    const action = prompt(`Участник: ${names.get(member.user_id) || member.user_id}\nВведи: admin — назначить администратором; member — снять права; remove — удалить участника.`);
    if (!action) return;
    let result;
    if (action === "admin" || action === "member") result = await supabase.rpc("group_set_member_role", { target_group: groupId, target_user: member.user_id, new_role: action });
    else if (action === "remove") result = await supabase.rpc("group_remove_member", { target_group: groupId, target_user: member.user_id });
    else return say("Неизвестное действие.");
    return say(result.error ? result.error.message : "Изменения участников сохранены.");
  }
  const { data: profile, error: profileError } = await supabase.from("profiles").select("id,username").ilike("username", choice.trim()).maybeSingle();
  if (profileError || !profile) return say("Пользователь не найден. Проверь точное написание ника.");
  const { error: addError } = await supabase.rpc("group_add_member", { target_group: groupId, target_user: profile.id });
  say(addError ? "Не удалось добавить участника: " + addError.message : `${profile.username} добавлен в группу.`);
}

async function openChannel(channelId) {
  activeChannelId = channelId; activeGroupId = null;
  const target = $("channelsList"); if (!target) return;
  const { data: channel, error } = await supabase.from("channels").select("id,name,description,visibility").eq("id", channelId).single();
  if (error) return say("Не удалось открыть канал: " + error.message);
  const { data: membership } = await supabase.from("channel_members").select("member_role").eq("channel_id", channelId).eq("user_id", currentUser.id).maybeSingle();
  const isMember = !!membership;
  const { count: subscriberCount } = await supabase.from("channel_members").select("user_id", { count: "exact", head: true }).eq("channel_id", channelId);
  target.innerHTML = `<div class="community-chat"><div class="community-chat-head"><button id="channelBack" class="secondary">← Каналы</button><div><h2>${esc(channel.name)}</h2><p class="muted">${esc(channel.description || "Канал")}</p><small class="muted">👥 ${subscriberCount || 0} подписчиков</small></div><span class="pill">${channel.visibility === "private" ? "Приватный" : "Публичный"}</span>${membership && ["owner","admin"].includes(membership.member_role) ? '<button id="channelMembersButton" class="secondary">Участники</button>' : ''}</div><div class="channel-toolbar"><button id="channelJoin" class="primary ${isMember ? "hidden" : ""}">Подписаться</button><form id="channelPostForm" class="community-compose ${membership && ["owner","admin"].includes(membership.member_role) ? "" : "hidden"}"><input id="channelPostInput" maxlength="10000" placeholder="Новая публикация…" required><button class="primary">Опубликовать</button></form></div><div id="channelPosts" class="community-messages">Загрузка публикаций…</div><p id="channelNotice" class="notice" aria-live="polite"></p></div>`;
  $("channelBack")?.addEventListener("click", () => loadCommunityPreview("channels"));
  $("channelMembersButton")?.addEventListener("click", async () => {
    const { data: members, error: membersError } = await supabase.from("channel_members").select("user_id,member_role").eq("channel_id", channelId);
    if (membersError) return communityMessage($("channelNotice"), membersError.message, true);
    const ids = (members || []).map(member => member.user_id);
    const { data: people } = ids.length ? await supabase.from("profiles").select("id,username").in("id", ids) : { data: [] };
    const names = new Map((people || []).map(person => [person.id, person.username]));
    const list = (members || []).map((member, index) => `${index + 1}. ${names.get(member.user_id) || member.user_id} — ${member.member_role}`).join("\n");
    const choice = prompt("Участники канала:\n" + (list || "Пока нет участников") + "\n\nВведи +ник чтобы пригласить или номер участника чтобы удалить:");
    if (!choice) return;
    if (choice.trim().startsWith("+")) {
      const { data: person } = await supabase.from("profiles").select("id,username").ilike("username", choice.trim().slice(1)).maybeSingle();
      if (!person) return communityMessage($("channelNotice"), "Пользователь не найден.", true);
      const grantAdmin = confirm("Назначить пользователя администратором канала? OK — администратор, Отмена — подписчик.");
      const { error: inviteError } = await supabase.rpc("channel_add_member", { target_channel: channelId, target_user: person.id, grant_admin: grantAdmin });
      return communityMessage($("channelNotice"), inviteError ? inviteError.message : `${person.username} добавлен.`, !!inviteError);
    }
    const member = members[Number(choice) - 1];
    if (!member) return communityMessage($("channelNotice"), "Такого номера нет.", true);
    if (member.member_role === "owner") return communityMessage($("channelNotice"), "Владельца канала нельзя удалить.", true);
    const { error: removeError } = await supabase.rpc("channel_remove_member", { target_channel: channelId, target_user: member.user_id });
    communityMessage($("channelNotice"), removeError ? removeError.message : "Участник удалён.", !!removeError);
  });
  $("channelJoin")?.addEventListener("click", async () => {
    const { error: joinError } = await supabase.from("channel_members").insert({ channel_id: channelId, user_id: currentUser.id, member_role: "subscriber" });
    if (joinError) communityMessage($("channelNotice"), joinError.message, true); else { say("Подписка оформлена."); openChannel(channelId); }
  });
  $("channelPostForm")?.addEventListener("submit", async e => {
    e.preventDefault(); const input = $("channelPostInput"); const content = input.value.trim(); if (!content) return;
    const { error: postError } = await supabase.from("channel_posts").insert({ channel_id: channelId, author_id: currentUser.id, content });
    if (postError) communityMessage($("channelNotice"), postError.message, true); else { input.value = ""; await loadChannelPosts(channelId); }
  });
  const { error: viewsError } = await supabase.rpc("record_channel_post_views", { target_channel: channelId });
  if (viewsError) console.warn("Channel view counter:", viewsError.message);
  await loadChannelPosts(channelId);
  if (communityRealtime) await supabase.removeChannel(communityRealtime);
  communityRealtime = supabase.channel("channel-posts-" + channelId).on("postgres_changes", { event: "*", schema: "public", table: "channel_posts", filter: "channel_id=eq." + channelId }, () => loadChannelPosts(channelId)).subscribe();
}

async function loadChannelPosts(channelId) {
  const target = $("channelPosts"); if (!target) return;
  const { data, error } = await supabase.from("channel_posts").select("id,content,author_id,created_at,views_count").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(100);
  if (error) { target.textContent = "Не удалось загрузить публикации: " + error.message; return; }
  target.replaceChildren();
  for (const post of data || []) {
    const row = document.createElement("article"); row.className = "community-message";
    const author = document.createElement("strong"); author.textContent = post.author_id === currentUser.id ? "Вы" : "Автор канала";
    const body = document.createElement("p"); body.textContent = post.content;
    const time = document.createElement("small"); time.textContent = `${formatTime(post.created_at)} · 👁 ${post.views_count || 0}`;
    row.append(author, body, time); target.append(row);
  }
  if (!data?.length) target.textContent = "Публикаций пока нет.";
}


// =====================================
// WEBRTC AUDIO / VIDEO CALLS
// Uses Supabase Realtime broadcast for signaling. STUN is included;
// a TURN server must be configured for reliable cross-network calls.
// =====================================
let rtcPeer = null;
let rtcStream = null;
let rtcRoom = null;
let rtcIncomingChannel = null;
let activeCallId = null;

function callNotice(message) { const el = $("callNotice"); if (el) el.textContent = message; say(message); }
function ensureCallMedia() {
  if (!$("callRemoteVideo")) return;
  $("callLocalVideo").muted = true;
}
function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 5000);
    const done = () => {
      if (peer.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", done);
  });
}

function stopCurrentCall(notifyPeer = true) {
  if (notifyPeer && rtcRoom && activeCallId) rtcRoom.send({ type: "broadcast", event: "hangup", payload: { userId: currentUser?.id } }).catch(() => {});
  if (rtcPeer) rtcPeer.close(); rtcPeer = null;
  if (rtcStream) rtcStream.getTracks().forEach(track => track.stop()); rtcStream = null;
  if ($("callLocalVideo")) $("callLocalVideo").srcObject = null;
  if ($("callRemoteVideo")) $("callRemoteVideo").srcObject = null;
  if (rtcRoom) supabase.removeChannel(rtcRoom); rtcRoom = null;
  activeCallId = null;
  if ($("callControls")) $("callControls").classList.add("hidden");
}

async function startDirectCall(targetUserId, withVideo) {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return callNotice("Браузер не поддерживает WebRTC или доступ к камере/микрофону.");
  try {
    stopCurrentCall();
    activeCallId = crypto.randomUUID();
    rtcStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!withVideo });
    ensureCallMedia();
    if ($("callLocalVideo")) { $("callLocalVideo").srcObject = rtcStream; $("callLocalVideo").classList.toggle("hidden", !withVideo); }
    if ($("callControls")) $("callControls").classList.remove("hidden");
    rtcPeer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }] });
    rtcStream.getTracks().forEach(track => rtcPeer.addTrack(track, rtcStream));
    rtcPeer.ontrack = event => { if ($("callRemoteVideo")) $("callRemoteVideo").srcObject = event.streams[0]; };
    rtcPeer.onicecandidate = event => { if (event.candidate && rtcRoom) rtcRoom.send({ type: "broadcast", event: "ice", payload: { candidate: event.candidate } }); };
    rtcRoom = supabase.channel("call-room-" + activeCallId);
    rtcRoom.on("broadcast", { event: "answer" }, async ({ payload }) => { if (rtcPeer && payload?.sdp) await rtcPeer.setRemoteDescription(payload.sdp); });
    rtcRoom.on("broadcast", { event: "ice" }, async ({ payload }) => { try { if (payload?.candidate && rtcPeer) await rtcPeer.addIceCandidate(payload.candidate); } catch (e) { console.warn(e); } });
    rtcRoom.on("broadcast", { event: "hangup" }, () => { stopCurrentCall(false); callNotice("Собеседник завершил звонок."); });
    rtcRoom.on("broadcast", { event: "decline" }, () => { stopCurrentCall(); callNotice("Собеседник отклонил вызов."); });
    await rtcRoom.subscribe();
    const offer = await rtcPeer.createOffer(); await rtcPeer.setLocalDescription(offer);
    await waitForIceGathering(rtcPeer);
    const { data: me } = await supabase.from("profiles").select("username").eq("id", currentUser.id).single();
    const incoming = supabase.channel("user-calls-" + targetUserId);
    await incoming.subscribe();
    await incoming.send({ type: "broadcast", event: "incoming", payload: { callId: activeCallId, from: currentUser.id, fromName: me?.username || "Пользователь", withVideo: !!withVideo, offer: rtcPeer.localDescription } });
    supabase.removeChannel(incoming);
    callNotice(withVideo ? "Видеозвонок: вызов отправлен…" : "Голосовой звонок: вызов отправлен…");
    showPage("calls");
  } catch (error) { stopCurrentCall(); callNotice("Не удалось начать звонок: " + error.message); }
}

async function acceptIncomingCall(payload) {
  try {
    stopCurrentCall(); activeCallId = payload.callId;
    rtcStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!payload.withVideo });
    if ($("callLocalVideo")) { $("callLocalVideo").srcObject = rtcStream; $("callLocalVideo").classList.toggle("hidden", !payload.withVideo); }
    if ($("callControls")) $("callControls").classList.remove("hidden");
    rtcPeer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }] });
    rtcStream.getTracks().forEach(track => rtcPeer.addTrack(track, rtcStream));
    rtcPeer.ontrack = event => { if ($("callRemoteVideo")) $("callRemoteVideo").srcObject = event.streams[0]; };
    rtcRoom = supabase.channel("call-room-" + activeCallId);
    rtcRoom.on("broadcast", { event: "ice" }, async ({ payload: p }) => { try { if (p?.candidate) await rtcPeer.addIceCandidate(p.candidate); } catch (e) { console.warn(e); } });
    rtcRoom.on("broadcast", { event: "hangup" }, () => { stopCurrentCall(false); callNotice("Собеседник завершил звонок."); });
    await rtcRoom.subscribe();
    await rtcPeer.setRemoteDescription(payload.offer);
    rtcPeer.onicecandidate = event => { if (event.candidate) rtcRoom.send({ type: "broadcast", event: "ice", payload: { candidate: event.candidate } }); };
    const answer = await rtcPeer.createAnswer(); await rtcPeer.setLocalDescription(answer);
    await rtcRoom.send({ type: "broadcast", event: "answer", payload: { sdp: rtcPeer.localDescription } });
    showPage("calls");
    callNotice("Звонок подключается…");
  } catch (error) { stopCurrentCall(); callNotice("Не удалось принять вызов: " + error.message); }
}

function setupIncomingCalls() {
  if (!currentUser) return;
  if (rtcIncomingChannel) supabase.removeChannel(rtcIncomingChannel);
  rtcIncomingChannel = supabase.channel("user-calls-" + currentUser.id);
  rtcIncomingChannel.on("broadcast", { event: "incoming" }, ({ payload }) => {
    if (!payload?.offer || !payload?.callId) return;
    const answer = confirm(`${payload.fromName || "Пользователь"} звонит вам. Принять ${payload.withVideo ? "видеозвонок" : "голосовой звонок"}?`);
    if (answer) acceptIncomingCall(payload);
    else {
      const room = supabase.channel("call-room-" + payload.callId);
      room.subscribe(async status => { if (status === "SUBSCRIBED") { await room.send({ type: "broadcast", event: "decline", payload: { userId: currentUser.id } }); supabase.removeChannel(room); } });
    }
  }).subscribe();
}

$("callEndButton")?.addEventListener("click", stopCurrentCall);
$("callMuteButton")?.addEventListener("click", () => { const track = rtcStream?.getAudioTracks()[0]; if (track) { track.enabled = !track.enabled; $("callMuteButton").textContent = track.enabled ? "🎙 Выключить микрофон" : "🔇 Включить микрофон"; } });
$("callCameraButton")?.addEventListener("click", () => { const track = rtcStream?.getVideoTracks()[0]; if (track) { track.enabled = !track.enabled; $("callCameraButton").textContent = track.enabled ? "📷 Выключить камеру" : "▣ Включить камеру"; } });
$("callPageOpen")?.addEventListener("click", () => showPage("calls"));


// =====================================
// АВТОРИЗАЦИЯ
// =====================================

function switchAuth(tab) {
  $("loginForm")?.classList.toggle("hidden", tab !== "login");
  $("signupForm")?.classList.toggle("hidden", tab !== "signup");

  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  say("", "authMessage");
}

let qrPollTimer = null;
let qrPollBusy = false;
let qrPollSecret = null;
let qrImageUrl = null;

function stopQrLogin(message = "") {
  clearInterval(qrPollTimer);
  qrPollTimer = null;
  qrPollSecret = null;
  if (qrImageUrl) URL.revokeObjectURL(qrImageUrl);
  qrImageUrl = null;
  $("qrLoginImage")?.classList.add("hidden");
  $("qrLoginCode")?.classList.add("hidden");
  if ($("qrLoginStatus") && message) $("qrLoginStatus").textContent = message;
}

async function pollQrLogin(challengeId) {
  if (!qrPollSecret || qrPollBusy) return;
  qrPollBusy = true;
  try {
    const { data, error } = await supabase.functions.invoke("qr-login-poll", {
      body: { challenge_id: challengeId, poll_verifier: qrPollSecret }
    });
    if (error) throw error;
    if (data?.status === "pending") return;
    if (data?.status === "expired") {
      stopQrLogin("Время действия QR-кода истекло. Создай новый код.");
      return;
    }
    if (data?.status === "approved" && data?.token_hash) {
      stopQrLogin("Вход подтверждён. Выполняю вход…");
      const { error: authError } = await supabase.auth.verifyOtp({
        token_hash: data.token_hash,
        type: "magiclink"
      });
      if (authError) say("Не удалось завершить QR-вход: " + authError.message, "qrLoginStatus");
      return;
    }
    if (data?.status === "consumed") stopQrLogin("Этот QR-код уже использован. Создай новый.");
    if (data?.status === "invalid") stopQrLogin("Запрос входа недействителен. Создай новый QR-код.");
  } catch (error) {
    stopQrLogin("Не удалось проверить вход: " + (error?.message || "ошибка соединения"));
  } finally {
    qrPollBusy = false;
  }
}

$("startQrLogin")?.addEventListener("click", async () => {
  stopQrLogin();
  $("qrLoginPanel")?.classList.remove("hidden");
  $("qrLoginStatus").textContent = "Создаю одноразовый QR-код…";
  $("startQrLogin").disabled = true;
  try {
    const { data, error } = await supabase.functions.invoke("qr-login-create", { body: {} });
    if (error) throw error;
    if (!data?.challenge_id || !data?.poll_verifier || !data?.qr_svg || !data?.display_code) throw new Error("Сервер вернул неполный ответ.");
    qrPollSecret = data.poll_verifier;
    qrImageUrl = URL.createObjectURL(new Blob([data.qr_svg], { type: "image/svg+xml" }));
    $("qrLoginImage").src = qrImageUrl;
    $("qrLoginImage").classList.remove("hidden");
    $("qrLoginCode").textContent = "Код подтверждения: " + data.display_code;
    $("qrLoginCode").classList.remove("hidden");
    $("qrLoginStatus").textContent = "Ожидаю подтверждения на твоём устройстве…";
    await pollQrLogin(data.challenge_id);
    if (qrPollSecret) qrPollTimer = setInterval(() => pollQrLogin(data.challenge_id), 1800);
  } catch (error) {
    stopQrLogin("Не удалось создать QR-вход: " + (error?.message || "ошибка сервера"));
  } finally {
    $("startQrLogin").disabled = false;
  }
});

$("cancelQrLogin")?.addEventListener("click", () => {
  stopQrLogin("Вход отменён.");
  $("qrLoginPanel")?.classList.add("hidden");
});

function readQrApproval() {
  const values = new URLSearchParams(location.hash.slice(1));
  const challengeId = values.get("qr");
  const verifier = values.get("v");
  const code = values.get("c");
  return challengeId && verifier && code ? { challengeId, verifier, code } : null;
}

function clearQrApprovalHash() {
  history.replaceState(null, "", location.pathname + location.search);
}

async function approveQrLoginIfPresent() {
  const approval = readQrApproval();
  if (!approval || !currentUser) return;
  if (!confirm(`Разрешить вход на другом устройстве? Сверь код ${approval.code} с кодом на экране, где создан QR. Подтверждай только при совпадении.`)) {
    clearQrApprovalHash();
    return;
  }
  const { error } = await supabase.rpc("approve_qr_login", {
    challenge_id: approval.challengeId,
    verifier: approval.verifier
  });
  clearQrApprovalHash();
  say(error ? "QR-запрос истёк или уже использован." : "Вход подтверждён на другом устройстве.");
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => switchAuth(button.dataset.tab));
});

$("loginForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  const { error } = await supabase.auth.signInWithPassword({
    email: $("loginEmail").value.trim(),
    password: $("loginPassword").value
  });

  if (error) {
    say(error.message, "authMessage");
    return;
  }

  await boot();
});

$("signupForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  const username = $("signupName").value.trim();

  if (username.length < 2) {
    return say("Имя должно содержать минимум 2 символа.", "authMessage");
  }

  const { data, error } = await supabase.auth.signUp({
    email: $("signupEmail").value.trim(),
    password: $("signupPassword").value,
    options: {
      data: { username }
    }
  });

  if (error) {
    say(error.code === "23505" ? "Это имя уже занято. Выберите другое." : error.message, "authMessage");
    return;
  }

  if (!data.session) {
    say(
      "Аккаунт создан. Проверь почту и подтверди email, затем войди.",
      "authMessage"
    );
    return;
  }

  await boot();
});

$("logoutBtn")?.addEventListener("click", async () => {
  await removeMessagesChannel();

  await supabase.auth.signOut();

  currentUser = null;
  currentProfile = null;
  activeChatUser = null;

  $("appView")?.classList.add("hidden");
  $("authView")?.classList.remove("hidden");

  if ($("topUser")) $("topUser").textContent = "";
});

// =====================================
// ЗАПУСК ПРИЛОЖЕНИЯ
// =====================================

async function boot() {
  if (bootRunning) return;

  bootRunning = true;

  try {
    const {
      data: { session },
      error: sessionError
    } = await supabase.auth.getSession();

    if (sessionError) throw sessionError;

    if (!session) {
      currentUser = null;
      currentProfile = null;
      activeChatUser = null;

      await removeMessagesChannel();

      $("authView")?.classList.remove("hidden");
      $("appView")?.classList.add("hidden");
      if (readQrApproval()) {
        clearQrApprovalHash();
        say("На этом устройстве сначала войди в аккаунт, затем отсканируй QR-код ещё раз.", "authMessage");
      }

      return;
    }

    currentUser = session.user;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .single();

    if (error || !profile) {
      say("Профиль ещё создаётся. Обнови страницу через несколько секунд.");
      return;
    }

    currentProfile = profile;
    const { data: privateProfile } = await supabase
      .from("profile_private")
      .select("presence_mode")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    currentPresenceMode = privateProfile?.presence_mode || "online";
    if (typeof updateStaffBonusVisibility === "function") updateStaffBonusVisibility();

    $("authView")?.classList.add("hidden");
    $("appView")?.classList.remove("hidden");

    if ($("topUser")) {
      $("topUser").textContent =
        profile.username + " · " + roleLabel(profile.role);
    }

    if ($("myName")) {
      $("myName").textContent = profile.username;
    }

    if ($("myAvatar")) {
      $("myAvatar").innerHTML = avatarContent(profile);
    }

    if ($("myRole")) {
      const rep = Number(profile.reputation_level ?? 1);
      const repText = ({ 1: "Репутация +1", 0: "Репутация 0", "-1": "Репутация −1", "-2": "Репутация −2", "-3": "Репутация −3" })[rep] || `Репутация ${rep}`;
      $("myRole").innerHTML = `<span class="pill">${esc(roleLabel(profile.role))}</span><span class="reputation-badge" title="Уровень репутации">✦ ${esc(repText)}</span>`;
    }

    if ($("myStatus")) {
      $("myStatus").textContent =
        presenceLabel(currentPresenceMode);
    }

    $("adminNav")?.classList.toggle(
      "hidden",
      !["owner", "ceo", "deputy_ceo", "admin", "moderator"].includes(profile.role)
    );

    const theme = localStorage.getItem("apple-theme") || "burgundy";

    document.body.classList.toggle("dark", theme === "dark");
    document.body.dataset.theme = theme;

    setupMessagesRealtime();
    setupIncomingCalls();

    await approveQrLoginIfPresent();

    showPage("messages");

  } catch (error) {
    say("Ошибка запуска: " + error.message);
  } finally {
    bootRunning = false;
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    currentUser = null;
    currentProfile = null;
    activeChatUser = null;

    removeMessagesChannel();

    $("appView")?.classList.add("hidden");
    $("authView")?.classList.remove("hidden");

    if ($("topUser")) $("topUser").textContent = "";
  }

  if (event === "SIGNED_IN" && session) {
    setTimeout(() => boot(), 0);
  }
});

// =====================================
// ЛЕНТА
// =====================================

$("postForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const content = $("postText").value.trim();

  if (!content) return;

  const { error } = await supabase
    .from("posts")
    .insert({
      user_id: currentUser.id,
      content
    });

  if (error) return say(error.message);

  $("postText").value = "";

  say("Публикация добавлена.");

  await loadFeed();
});

async function loadFeedOnce() {
  if (!currentUser || !$("feedList")) return;

  const { data, error } = await supabase
    .from("posts")
    .select(`
      id,
      user_id,
      content,
      created_at,
      profiles (
        id,
        username,
        role,
        avatar_url,
        avatar_emoji,
        handle
      )
    `)
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) return say(error.message);

  $("feedList").innerHTML = (data || []).map(post => {
    const author = post.profiles || {};

    return `
      <article class="post">

        <div class="post-head">

          ${renderAvatarButton(author, "post-avatar")}

          <div class="user-info">
            <strong>${esc(author.username || "Пользователь")}</strong>

            <span class="pill">
              ${esc(roleLabel(author.role))}
            </span>

            <small class="muted">
              ${profileHandle(author)}
            </small>
          </div>

          <span class="post-date">
            ${formatTime(post.created_at)}
          </span>

        </div>

        <div class="post-body">
          ${esc(post.content)}
        </div>

        ${post.user_id === currentUser.id ? `<div class="post-actions"><button type="button" data-post-edit="${esc(post.id)}">Изменить</button><button type="button" data-post-delete="${esc(post.id)}">Удалить</button></div>` : ""}
        <form class="comment-form" data-comment-form="${esc(post.id)}"><input maxlength="1000" required placeholder="Ответить пользователю"><button type="submit">Ответить</button></form>
        <div class="post-comments" data-comments="${esc(post.id)}"></div>

        ${profileLink(author)}

      </article>
    `;
  }).join("") || `
    <div class="panel pad muted">
      Публикаций пока нет. Будь первым!
    </div>
  `;

  await loadComments(data || []);
}

async function loadFeed() {
  if (!feedLoadPromise) {
    feedLoadPromise = loadFeedOnce().finally(() => { feedLoadPromise = null; });
  }
  return feedLoadPromise;
}

async function loadComments(posts) {
  if (!posts.length) return;
  const { data, error } = await supabase.from("post_comments").select("post_id,user_id,content,profiles(username)").in("post_id", posts.map(post => post.id)).order("created_at");
  if (error) return;
  for (const row of data || []) {
    const target = document.querySelector(`[data-comments="${CSS.escape(row.post_id)}"]`);
    if (!target) continue;
    const line = document.createElement("p");
    line.textContent = `${row.profiles?.username || "Пользователь"}: ${row.content}`;
    target.append(line);
  }
}

document.addEventListener("submit", async event => {
  const form = event.target.closest("[data-comment-form]");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("input");
  const { error } = await supabase.from("post_comments").insert({ post_id: form.dataset.commentForm, user_id: currentUser.id, content: input.value.trim() });
  if (error) return say(error.message);
  await loadFeed();
});
document.addEventListener("click", async event => {
  const del = event.target.closest("[data-post-delete]");
  const edit = event.target.closest("[data-post-edit]");
  if (del) {
    const { error } = await supabase.from("posts").delete().eq("id", del.dataset.postDelete).eq("user_id", currentUser.id);
    if (error) return say(error.message);
    await loadFeed();
  }
  if (edit) {
    const body = edit.closest(".post")?.querySelector(".post-body");
    const replacement = prompt("Изменить публикацию", body?.textContent || "");
    if (replacement === null) return;
    const { error } = await supabase.from("posts").update({ content: replacement.trim() }).eq("id", edit.dataset.postEdit).eq("user_id", currentUser.id);
    if (error) return say(error.message);
    await loadFeed();
  }
});

// =====================================
// ПОИСК ПОЛЬЗОВАТЕЛЕЙ
// =====================================

$("peopleSearch")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchPeople, 300);
});

async function searchPeople() {
  if (!currentUser || !$("peopleResults")) return;
  const requestId = ++searchRequestId;

  if ($("peopleWelcome")) $("peopleWelcome").textContent = "Welcome, " + (currentProfile?.username || "friend") + "!";

  const term = $("peopleSearch")?.value.trim() || "";

  let query = supabase
    .from("profiles")
    .select(`
      id,
      username,
      role,
      avatar_url,
      avatar_emoji,
      handle
    `)
    .neq("id", currentUser.id)
    .order("username")
    .limit(30);

  if (term) {
    const cleanTerm = term.replace(/^@/, "").replace(/[,%()]/g, "");

    query = query.or(
      `username.ilike.%${cleanTerm}%,handle.ilike.%${cleanTerm}%`
    );
  }

  const [{ data, error }, { data: outgoing }, { data: incoming }] = await Promise.all([
    query,
    supabase.from("friendships").select("recipient_id,status").eq("requester_id", currentUser.id),
    supabase.from("friendships").select("requester_id,status").eq("recipient_id", currentUser.id)
  ]);

  if (error) return say(error.message);
  if (requestId !== searchRequestId) return;

  const relations = new Map();

  (outgoing || []).forEach(item => {
    relations.set(item.recipient_id, item.status);
  });

  (incoming || []).forEach(item => {
    relations.set(item.requester_id, item.status);
  });

  $("peopleResults").innerHTML = (data || []).map(person => {
    const state = relations.get(person.id);

    let action = "";

    if (state === "accepted") {
      action = `<span class="pill">Уже друзья</span>`;
    } else if (state === "pending") {
      action = `<span class="muted">Заявка отправлена</span>`;
    } else {
      action = `
        <button class="primary" data-add="${esc(person.id)}">
          Добавить в друзья
        </button>
      `;
    }

    return `
      <div class="result-row">

        <div class="person-main">

          ${renderAvatarButton(person)}

          <div class="user-info">
            <button
              type="button"
              class="person-name-button"
              data-profile-open="${esc(person.id)}"
            >
              ${esc(person.username)}
            </button>

            <span class="pill">
              ${esc(roleLabel(person.role))}
            </span>

            <small class="muted">
              ${profileHandle(person)}
            </small>

            <small class="muted" data-presence-for="${esc(person.id)}">
              …
            </small>
          </div>

        </div>

        <div class="person-actions">
          ${action}
          ${profileLink(person)}
        </div>

      </div>
    `;
  }).join("") || `<p class="muted">Пользователи не найдены.</p>`;

  await fillPresenceForProfiles($("peopleResults"), data || []);
  document.querySelectorAll("[data-add]").forEach(button => {
    button.addEventListener("click", () => {
      sendFriendRequest(button.dataset.add);
    });
  });
}

async function sendFriendRequest(id) {
  const { error } = await supabase
    .from("friendships")
    .insert({
      requester_id: currentUser.id,
      recipient_id: id
    });

  if (error) return say(error.message);

  say("Заявка в друзья отправлена.");

  await searchPeople();
}

// =====================================
// ДРУЗЬЯ
// =====================================

async function getAcceptedFriends() {
  if (!currentUser) return [];

  const fields = `
    id,
    username,
    avatar_url,
    avatar_emoji,
    handle,
    role
  `;

  const [sentResult, receivedResult] = await Promise.all([
    supabase
      .from("friendships")
      .select(`recipient_id,profiles!friendships_recipient_id_fkey(${fields})`)
      .eq("requester_id", currentUser.id)
      .eq("status", "accepted"),
    supabase
      .from("friendships")
      .select(`requester_id,profiles!friendships_requester_id_fkey(${fields})`)
      .eq("recipient_id", currentUser.id)
      .eq("status", "accepted")
  ]);

  const { data: sent, error: sentError } = sentResult;

  if (sentError) {
    say(sentError.message);
    return [];
  }

  const { data: received, error: receivedError } = receivedResult;

  if (receivedError) {
    say(receivedError.message);
    return [];
  }

  const all = [
    ...(sent || []).map(item => item.profiles),
    ...(received || []).map(item => item.profiles)
  ].filter(Boolean);

  return [...new Map(all.map(person => [person.id, person])).values()];
}

async function loadFriends() {
  if (!currentUser) return;

  const { data: incoming, error } = await supabase
    .from("friendships")
    .select(`
      id,
      requester_id,
      profiles!friendships_requester_id_fkey(
        id,
        username,
        avatar_url,
        avatar_emoji,
        handle,
        role
      )
    `)
    .eq("recipient_id", currentUser.id)
    .eq("status", "pending");

  if (error) say(error.message);

  $("incomingRequests").innerHTML = (incoming || []).map(request => {
    const person = request.profiles || {};

    return `
      <div class="result-row">

        <div class="person-main">
          ${renderAvatarButton(person)}

          <div class="user-info">
            <button
              type="button"
              class="person-name-button"
              data-profile-open="${esc(person.id || "")}"
            >
              ${esc(person.username || "Пользователь")}
            </button>

            <small class="muted">${profileHandle(person)}</small>
          </div>
        </div>

        <span>
          <button class="primary" data-accept="${esc(request.id)}">
            Принять
          </button>

          <button class="secondary" data-reject="${esc(request.id)}">
            Отклонить
          </button>
        </span>

      </div>
    `;
  }).join("") || `<p class="muted">Новых заявок нет.</p>`;

  document.querySelectorAll("[data-accept]").forEach(button => {
    button.addEventListener("click", () => {
      answerRequest(button.dataset.accept, "accepted");
    });
  });

  document.querySelectorAll("[data-reject]").forEach(button => {
    button.addEventListener("click", () => {
      answerRequest(button.dataset.reject, "rejected");
    });
  });

  const friends = await getAcceptedFriends();

  $("friendsList").innerHTML = friends.map(person => `
    <div class="result-row">

      <div class="person-main">
        ${renderAvatarButton(person)}

        <div class="user-info">
          <button
            type="button"
            class="person-name-button"
            data-profile-open="${esc(person.id)}"
          >
            ${esc(person.username)}
          </button>

          <small class="muted">${profileHandle(person)}</small>

          <small class="muted" data-presence-for="${esc(person.id)}">
            …
          </small>
        </div>
      </div>

      <button
        class="primary"
        data-open-chat="${esc(person.id)}"
        data-open-name="${esc(person.username)}"
      >
        Написать
      </button>

    </div>
  `).join("") || `<p class="muted">Пока нет друзей.</p>`;

  await fillPresenceForProfiles($("friendsList"), friends);
  document.querySelectorAll("[data-open-chat]").forEach(button => {
    button.addEventListener("click", () => {
      showPage("messages");

      openChat(
        button.dataset.openChat,
        button.dataset.openName
      );
    });
  });
}

async function answerRequest(id, status) {
  const { error } = await supabase
    .from("friendships")
    .update({ status })
    .eq("id", id);

  if (error) return say(error.message);

  say(
    status === "accepted"
      ? "Пользователь добавлен в друзья."
      : "Заявка отклонена."
  );

  await loadFriends();
}

// =====================================
// СООБЩЕНИЯ
// =====================================

async function loadContacts() {
  const target = $("contactsList");
  if (!target || !currentUser) return;
  target.innerHTML = '<p class="muted">Загрузка контактов…</p>';
  const friends = await getAcceptedFriends();
  target.replaceChildren();
  for (const person of friends) {
    const row = document.createElement("article"); row.className = "contact-row";
    row.innerHTML = `${renderAvatar(person, "chat-contact-avatar")}<div class="contact-row-info"><strong>${esc(person.username)}</strong><small class="muted">${esc(profileHandle(person))}</small></div>`;
    row.append(makeCommunityButton("Написать", () => { showPage("messages"); openChat(person.id, person.username); }, "primary"));
    target.append(row);
  }
  if (!friends.length) target.innerHTML = '<p class="muted">Контактов пока нет. Добавь друзей через поиск пользователей.</p>';
}

async function loadMessageContacts() {
  if (!currentUser) return;

  const friends = await getAcceptedFriends();

  $("messageContacts").innerHTML = friends.map(person => `
    <button
      class="chat-contact ${activeChatUser?.id === person.id ? "active" : ""}"
      data-chat-id="${esc(person.id)}"
      data-chat-name="${esc(person.username)}"
    >
      ${renderAvatar(person, "chat-contact-avatar")}

      <span class="chat-contact-info">
        <strong>${esc(person.username)}</strong>
        <small class="muted">${profileHandle(person)}</small>
      </span>
    </button>
  `).join("") || `
    <p class="muted">
      У тебя пока нет друзей. Добавь кого-нибудь, чтобы начать переписку.
    </p>
  `;

  document.querySelectorAll("[data-chat-id]").forEach(button => {
    button.addEventListener("click", () => {
      openChat(
        button.dataset.chatId,
        button.dataset.chatName
      );
    });
  });
}

async function openChat(friendId, friendName) {
  if (!currentUser) return;

  activeChatUser = {
    id: friendId,
    username: friendName
  };

  $("chatHeader").innerHTML = `
    <p class="muted">Загрузка профиля...</p>
  `;

  $("chatHistory").innerHTML = `
    <p class="muted">Загрузка переписки...</p>
  `;

  $("messageInput").disabled = false;
  $("messageSend").disabled = false;

  const { data: friend, error } = await supabase
    .from("profiles")
    .select(`
      id,
      username,
      role,
      handle,
      avatar_url,
      avatar_emoji,
      bio,
      created_at
    `)
    .eq("id", friendId)
    .single();

  if (error || !friend) {
    say("Не удалось загрузить профиль собеседника.");
    $("chatHeader").textContent = friendName || "Переписка";
    return;
  }

  activeChatUser = friend;
  const { data: chatPresence } = await supabase.rpc("visible_presence", { target_user: friend.id });
  friend.presence_mode = chatPresence;
  $("messageInput").placeholder = "Написать " + friend.username + "!";

  $("chatHeader").innerHTML = `
    <button
      type="button"
      class="chat-header-profile"
      data-profile-open="${esc(friend.id)}"
      title="Открыть профиль"
    >
      ${renderAvatar(friend, "chat-header-avatar")}

      <span class="chat-header-info">
        <strong>${esc(friend.username)}</strong>
        <small>${esc(presenceLabel(friend.presence_mode))}</small>
      </span>
    </button>
  `;
  const callActions = document.createElement("div");
  callActions.className = "chat-call-actions";
  const audioCall = makeCommunityButton("☎", () => startDirectCall(friend.id, false), "secondary");
  audioCall.title = "Голосовой звонок";
  const videoCall = makeCommunityButton("▣", () => startDirectCall(friend.id, true), "secondary");
  videoCall.title = "Видеозвонок";
  callActions.append(audioCall, videoCall);
  $("chatHeader")?.append(callActions);
  if (window.matchMedia("(max-width: 700px)").matches) {
    document.getElementById("page-messages")?.classList.add("chat-mobile-open");
    if (!$("chatMobileBack")) {
      const back = document.createElement("button"); back.id = "chatMobileBack"; back.className = "secondary chat-mobile-back"; back.type = "button"; back.textContent = "← Чаты";
      back.addEventListener("click", () => document.getElementById("page-messages")?.classList.remove("chat-mobile-open"));
      $("chatHeader")?.prepend(back);
    }
  }

  await loadMessageContacts();
  await loadChatMessages();

  $("messageInput").focus();
}

async function loadChatMessages() {
  if (!currentUser || !activeChatUser) return;

  const selectedFriendId = activeChatUser.id;

  const { data, error } = await supabase
    .from("messages")
    .select("id,sender_id,receiver_id,content,created_at")
    .or(
      `and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedFriendId}),and(sender_id.eq.${selectedFriendId},receiver_id.eq.${currentUser.id})`
    )
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    $("chatHistory").innerHTML = `
      <p class="muted">
        Ошибка загрузки сообщений: ${esc(error.message)}
      </p>
    `;
    return;
  }

  if (!activeChatUser || activeChatUser.id !== selectedFriendId) {
    return;
  }

  const messageIds = (data || []).map(message => message.id);
  let attachmentsByMessage = new Map();
  if (messageIds.length) {
    const { data: attachments } = await supabase
      .from("message_attachments")
      .select("message_id,storage_path,file_name,mime_type")
      .in("message_id", messageIds);
    attachmentsByMessage = new Map();
    const signedAttachments = await Promise.all((attachments || []).map(async attachment => {
      const { data: signed } = await supabase.storage
        .from("message-files")
        .createSignedUrl(attachment.storage_path, 600);
      return signed?.signedUrl ? { ...attachment, url: signed.signedUrl } : null;
    }));
    for (const attachment of signedAttachments) {
      if (!attachment) continue;
      const items = attachmentsByMessage.get(attachment.message_id) || [];
      items.push(attachment);
      attachmentsByMessage.set(attachment.message_id, items);
    }
  }

  if (!activeChatUser || activeChatUser.id !== selectedFriendId) return;

  $("chatHistory").innerHTML = (data || []).map(message => {
    const mine = message.sender_id === currentUser.id;
    const attached = (attachmentsByMessage.get(message.id) || []).map(file => {
      const name = esc(file.file_name);
      const url = esc(file.url);
      if (file.mime_type.startsWith("image/")) return `<a class="message-attachment" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}" loading="lazy"></a>`;
      if (file.mime_type.startsWith("video/")) return `<video class="message-attachment" src="${url}" controls preload="metadata" aria-label="${name}"></video>`;
      if (file.mime_type.startsWith("audio/")) return `<audio class="message-attachment" src="${url}" controls preload="metadata" aria-label="${name}"></audio>`;
      return `<a class="message-file-link" href="${url}" target="_blank" rel="noopener" download="${name}">📎 ${name}</a>`;
    }).join("");

    return `
      <div class="chat-message ${mine ? "mine" : "theirs"}">
        <div class="chat-message-text">${esc(message.content)}</div>
        ${attached}

        <span class="chat-time">
          ${formatTime(message.created_at)}
        </span>
      </div>
    `;
  }).join("") || `
    <p class="muted">
      Сообщений пока нет. Напиши первым!
    </p>
  `;

  $("chatHistory").scrollTop = $("chatHistory").scrollHeight;
}

const MESSAGE_FILE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "audio/webm", "audio/mp4",
  "application/pdf", "text/plain"
]);

async function sendMessageAttachment(file, messageText = "") {
  if (!currentUser || !activeChatUser || sendingMessage) return;
  const mimeType = (file?.type || "").split(";")[0].trim().toLowerCase();
  if (!file || !MESSAGE_FILE_TYPES.has(mimeType)) {
    say("Этот формат файла не поддерживается.");
    return;
  }
  if (file.size < 1 || file.size > 10 * 1024 * 1024) {
    say("Файл должен быть размером не более 10 МБ.");
    return;
  }

  const recipientId = activeChatUser.id;
  const messageId = crypto.randomUUID();
  const safeName = (file.name || "voice-message").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 150);
  const storagePath = `${currentUser.id}/${messageId}/${crypto.randomUUID()}-${safeName}`;
  const content = (messageText || `Вложение: ${safeName}`).slice(0, 2000);
  sendingMessage = true;
  $("messageSend").disabled = true;
  $("attachMessageButton").disabled = true;
  $("voiceRecordButton").disabled = true;

  const { error: uploadError } = await supabase.storage
    .from("message-files")
    .upload(storagePath, file, { contentType: mimeType, upsert: false });
  if (uploadError) {
    say("Не удалось загрузить файл: " + uploadError.message);
    sendingMessage = false;
    $("messageSend").disabled = false;
    $("attachMessageButton").disabled = false;
    $("voiceRecordButton").disabled = false;
    return;
  }

  const { error: messageError } = await supabase.from("messages").insert({
    id: messageId, sender_id: currentUser.id, receiver_id: recipientId, content
  });
  if (messageError) {
    await supabase.storage.from("message-files").remove([storagePath]);
    say("Не удалось отправить сообщение: " + messageError.message);
  } else {
    const { error: metadataError } = await supabase.from("message_attachments").insert({
      message_id: messageId, sender_id: currentUser.id, storage_path: storagePath,
      file_name: safeName, mime_type: mimeType, file_size: file.size
    });
    if (metadataError) {
      await supabase.storage.from("message-files").remove([storagePath]);
      say("Файл не удалось прикрепить: " + metadataError.message);
    }
    if (activeChatUser?.id === recipientId) await loadChatMessages();
  }

  sendingMessage = false;
  $("messageSend").disabled = false;
  $("attachMessageButton").disabled = false;
  $("voiceRecordButton").disabled = false;
}

let pendingMessageFile = null;
let pendingMessagePreviewUrl = null;

function clearPendingMessageFile() {
  pendingMessageFile = null;
  if (pendingMessagePreviewUrl) URL.revokeObjectURL(pendingMessagePreviewUrl);
  pendingMessagePreviewUrl = null;
  $("messageAttachmentPreview")?.classList.add("hidden");
  $("messageAttachmentPreviewContent")?.replaceChildren();
  if ($("messageFileInput")) $("messageFileInput").value = "";
}

$("attachMessageButton")?.addEventListener("click", () => $("messageFileInput")?.click());
$("messageFileInput")?.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const mimeType = (file.type || "").toLowerCase();
  if (!MESSAGE_FILE_TYPES.has(mimeType)) {
    say("Этот формат файла не поддерживается.");
    clearPendingMessageFile();
    return;
  }
  if (file.size < 1 || file.size > 10 * 1024 * 1024) {
    say("Файл должен быть размером не более 10 МБ.");
    clearPendingMessageFile();
    return;
  }
  clearPendingMessageFile();
  pendingMessageFile = file;
  const content = $("messageAttachmentPreviewContent");
  const title = document.createElement("p");
  title.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} МБ`;
  content.append(title);
  if (mimeType.startsWith("image/")) {
    pendingMessagePreviewUrl = URL.createObjectURL(file);
    const image = document.createElement("img");
    image.src = pendingMessagePreviewUrl;
    image.alt = "Предпросмотр изображения";
    image.className = "attachment-image-preview";
    content.prepend(image);
  } else if (mimeType.startsWith("video/")) {
    pendingMessagePreviewUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = pendingMessagePreviewUrl;
    video.controls = true;
    video.className = "attachment-video-preview";
    content.prepend(video);
  }
  $("messageAttachmentPreview")?.classList.remove("hidden");
});
$("cancelPendingAttachment")?.addEventListener("click", clearPendingMessageFile);
$("sendPendingAttachment")?.addEventListener("click", async () => {
  if (!pendingMessageFile) return;
  const file = pendingMessageFile;
  clearPendingMessageFile();
  await sendMessageAttachment(file);
});

$("emojiToggle")?.addEventListener("click", () => $("messageEmojiPicker")?.classList.toggle("hidden"));
document.querySelectorAll("[data-message-emoji]").forEach(button => {
  button.addEventListener("click", () => {
    const input = $("messageInput");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const emoji = button.dataset.messageEmoji;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
    $("messageEmojiPicker").classList.add("hidden");
  });
});

let activeRecorder = null;
let voiceChunks = [];
let voiceBytes = 0;
let voiceStopTimer = null;
$("voiceRecordButton")?.addEventListener("click", async () => {
  const button = $("voiceRecordButton");
  if (activeRecorder?.state === "recording") {
    activeRecorder.stop();
    button.textContent = "🎙️";
    $("voiceRecordStatus").textContent = "Сохраняю запись…";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    say("Запись голоса не поддерживается этим браузером.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      stream.getTracks().forEach(track => track.stop());
      say("Этот браузер не поддерживает безопасный формат голосовой записи.");
      return;
    }
    activeRecorder = new MediaRecorder(stream, { mimeType });
    voiceChunks = [];
    voiceBytes = 0;
    activeRecorder.ondataavailable = event => {
      if (!event.data.size) return;
      voiceBytes += event.data.size;
      voiceChunks.push(event.data);
      if (voiceBytes > 10 * 1024 * 1024 && activeRecorder.state === "recording") {
        $("voiceRecordStatus").textContent = "Достигнут лимит 10 МБ…";
        activeRecorder.stop();
      }
    };
    activeRecorder.onstop = async () => {
      clearTimeout(voiceStopTimer);
      stream.getTracks().forEach(track => track.stop());
      const recordingMimeType = (activeRecorder.mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(voiceChunks, { type: recordingMimeType });
      $("voiceRecordStatus").textContent = "";
      if (blob.size > 10 * 1024 * 1024) {
        say("Запись больше 10 МБ и не была отправлена.");
        return;
      }
      const extension = blob.type.includes("mp4") ? "m4a" : "webm";
      await sendMessageAttachment(new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type }), "Голосовое сообщение");
    };
    activeRecorder.start(1000);
    voiceStopTimer = setTimeout(() => {
      if (activeRecorder?.state === "recording") {
        $("voiceRecordStatus").textContent = "Максимум 2 минуты…";
        activeRecorder.stop();
      }
    }, 120000);
    button.textContent = "⏹️";
    $("voiceRecordStatus").textContent = "Идёт запись · нажми ещё раз, чтобы отправить";
  } catch (error) {
    say("Не удалось получить доступ к микрофону: " + (error?.message || "проверь разрешение браузера"));
  }
});

$("messageForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser || !activeChatUser || sendingMessage) return;

  const content = $("messageInput").value.trim();

  if (!content) return;

  const receiverId = activeChatUser.id;

  sendingMessage = true;
  $("messageSend").disabled = true;

  const { error } = await supabase
    .from("messages")
    .insert({
      sender_id: currentUser.id,
      receiver_id: receiverId,
      content
    });

  sendingMessage = false;
  $("messageSend").disabled = false;

  if (error) {
    say("Не удалось отправить сообщение: " + error.message);
    return;
  }

  $("messageInput").value = "";

  if (activeChatUser?.id === receiverId) {
    await loadChatMessages();
  }

  $("messageInput").focus();
});

// =====================================
// REALTIME — ЖИВЫЕ СООБЩЕНИЯ
// =====================================

function setupMessagesRealtime() {
  if (!currentUser) return;

  if (messagesChannel) {
    supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  messagesChannel = supabase
    .channel("private-messages-" + currentUser.id)

    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `receiver_id=eq.${currentUser.id}`
      },
      async payload => {
        const newMessage = payload.new;

        if (
          activeChatUser &&
          activeChatUser.id === newMessage.sender_id
        ) {
          await loadChatMessages();
          // Attachments metadata is inserted immediately after the message row.
          setTimeout(() => {
            if (activeChatUser?.id === newMessage.sender_id) loadChatMessages();
          }, 700);
        } else {
          say("У тебя новое сообщение! Открой раздел «Сообщения».");
          document.title = "Новое сообщение · TheAppleBook";
          if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            new Notification("Новое сообщение", { body: "Открой TheAppleBook, чтобы прочитать его." });
          }
        }
      }
    )

    .subscribe(status => {
      if (status === "SUBSCRIBED") {
        console.log("TheAppleBook: Realtime messages connected.");
      }

      if (status === "CHANNEL_ERROR") {
        say("Не удалось подключить обновление сообщений в реальном времени.");
      }
    });
}

// =====================================
// ПРОФИЛЬ
// =====================================

function renderProfile() {
  if (!currentProfile || !$("profileDetails")) return;

  const profile = currentProfile;

  $("profileDetails").innerHTML = `
    <div class="profile-public-header">

      ${renderAvatar(profile, "profile-large-avatar")}

      <div>
        <h3>
          ${esc(profile.username)}
          <span class="pill">${esc(roleLabel(profile.role))}</span>
        </h3>

        <p class="muted">${profileHandle(profile)}</p>
        <span class="reputation-badge">✦ Репутация: ${Number(profile.reputation_level ?? 1)}</span>
      </div>

    </div>

    <p>
      <strong>Статус:</strong>
      ${esc(presenceLabel(currentPresenceMode))}
    </p>

    <p>
      <strong>О себе:</strong>
      ${esc(profile.bio || "Пока ничего не написано.")}
    </p>

    <p class="muted">
      В TheAppleBook с
      ${profile.created_at
        ? new Date(profile.created_at).toLocaleDateString("ru-RU")
        : "неизвестной даты"}
    </p>
  `;
}

// =====================================
// ОТКРЫТИЕ ПУБЛИЧНОГО ПРОФИЛЯ
// =====================================

async function openPublicProfile(id) {
  if (!id || !currentUser) return;

  if (id === currentUser.id) {
    showPage("profile");
    return;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(`
      id,
      username,
      role,
      bio,
      created_at,
      handle,
      avatar_url,
      avatar_emoji,
      featured_achievement,
      show_achievement
    `)
    .eq("id", id)
    .single();

  if (error || !data) {
    say("Не удалось открыть профиль.");
    return;
  }

  const { data: publicPresence } = await supabase.rpc("visible_presence", { target_user: id });
  data.presence_mode = publicPresence;
  const { data: publicPrivate } = await supabase.rpc("visible_profile_private", { target_user: id });
  data.public_phone = publicPrivate?.phone || null;
  data.public_age = publicPrivate?.age ?? null;

  // Записываем просмотр профиля
  const { error: viewError } = await supabase.rpc(
    "record_profile_view",
    {
      target_profile_id: id
    }
  );

  if (viewError) {
    console.warn("Не удалось записать просмотр профиля:", viewError.message);
  }

  $("publicProfileModal")?.remove();

  const modal = document.createElement("div");

  modal.id = "publicProfileModal";
  modal.className = "profile-modal";

  modal.innerHTML = `
    <div class="profile-modal-card">

      <button
        class="profile-modal-close"
        type="button"
        aria-label="Закрыть профиль"
      >×</button>

      ${renderAvatar(data, "profile-large-avatar")}

      <h2>${esc(data.username)}</h2>

      <span class="pill">
        ${esc(roleLabel(data.role))}
      </span>

      <p class="muted">${profileHandle(data)}</p>

      <div class="public-profile-info">

        <div class="public-profile-item">
          <strong>Статус</strong>
          <span>${esc(presenceLabel(data.presence_mode))}</span>
        </div>

        <div class="public-profile-item">
          <strong>О себе</strong>
          <span>${esc(data.bio || "Пока ничего не написано.")}</span>
        </div>

        ${data.public_phone ? `<div class="public-profile-item"><strong>Телефон</strong><span>${esc(data.public_phone)}</span></div>` : ""}
        ${data.public_age !== null ? `<div class="public-profile-item"><strong>Возраст</strong><span>${esc(data.public_age)} лет</span></div>` : ""}

        <div class="public-profile-item">
          <strong>Дата регистрации</strong>
          <span>
            ${data.created_at
              ? new Date(data.created_at).toLocaleDateString("ru-RU")
              : "Неизвестно"}
          </span>
        </div>

      </div>

    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => {
    modal.remove();
    document.removeEventListener("keydown", handleEscape);
  };

  const handleEscape = event => {
    if (event.key === "Escape") {
      closeModal();
    }
  };

  modal.querySelector(".profile-modal-close").addEventListener("click", closeModal);

  modal.addEventListener("click", event => {
    if (event.target === modal) {
      closeModal();
    }
  });

  document.addEventListener("keydown", handleEscape);
}

// Единый обработчик для всех кнопок открытия профиля.

document.addEventListener("click", event => {
  const button = event.target.closest("[data-profile-open]");

  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const profileId = button.dataset.profileOpen;

  if (profileId) {
    openPublicProfile(profileId);
  }
});

// =====================================
// НАСТРОЙКИ
// =====================================

function fillSettings() {
  if (!currentProfile) return;

  if ($("editName")) {
    $("editName").value = currentProfile.username || "";
  }

  if ($("editStatus")) {
    $("editStatus").value = currentPresenceMode;
  }

  if ($("editBio")) {
    $("editBio").value = currentProfile.bio || "";
  }

  if ($("accountStanding")) {
    const level = currentProfile.reputation_level ?? 1;
    const labels = { 1: "+1 · Хорошая репутация", 0: "0 · Ограниченный доступ", "-1": "-1 · Сильные ограничения", "-2": "-2 · Под угрозой", "-3": "-3 · Аккаунт приостановлен" };
    $("accountStanding").textContent = (labels[level] || labels[1]) + ". Решения о доступе должны сопровождаться объяснением и возможностью апелляции.";
    $("deactivateAccount")?.classList.toggle("hidden", currentProfile.account_state !== "active");
    $("reactivateAccount")?.classList.toggle("hidden", currentProfile.account_state !== "deactivated");
  }

  if ($("phoneInput") && currentUser) {
    supabase.from("profile_private").select("phone,phone_visible,birth_date,birth_date_visible,presence_mode").eq("user_id", currentUser.id).maybeSingle().then(({ data }) => {
      if (!data) return;
      currentPresenceMode = data.presence_mode || "online";
      if ($("editStatus")) $("editStatus").value = currentPresenceMode;
      $("phoneInput").value = data.phone || "";
      $("phoneVisible").checked = data.phone_visible;
      $("birthDateInput").value = data.birth_date || "";
      $("birthDateVisible").checked = data.birth_date_visible;
    });
  }

  if ($("themeSelect")) {
    $("themeSelect").value =
      localStorage.getItem("apple-theme") || "burgundy";
  }
}

$("savePrivateProfile")?.addEventListener("click", async () => {
  const { error } = await supabase.from("profile_private").upsert({
    user_id: currentUser.id,
    phone: $("phoneInput").value.trim() || null,
    phone_visible: $("phoneVisible").checked,
    birth_date: $("birthDateInput").value || null,
    birth_date_visible: $("birthDateVisible").checked,
    presence_mode: $("editStatus").value
  });
  $("accountSettingsMessage").textContent = error ? error.message : "Приватные данные сохранены.";
});

$("changeEmail")?.addEventListener("click", async () => {
  const email = $("newEmail").value.trim();
  if (!email) return;
  const { error } = await supabase.auth.updateUser({ email });
  $("accountSettingsMessage").textContent = error ? error.message : "Проверьте новую почту и подтвердите смену адреса.";
});
$("changePassword")?.addEventListener("click", async () => {
  const password = $("newPassword").value;
  if (password.length < 8) return say("Пароль должен содержать минимум 8 символов.", "accountSettingsMessage");
  const { error } = await supabase.auth.updateUser({ password });
  $("accountSettingsMessage").textContent = error ? error.message : "Пароль изменён.";
});
$("deactivateAccount")?.addEventListener("click", async () => {
  if (!confirm("Временно отключить аккаунт? Вы сможете войти и включить его снова.")) return;
  const { error } = await supabase.rpc("set_account_deactivated", { deactivate: true });
  if (error) return say(error.message, "accountSettingsMessage");
  await supabase.auth.signOut(); location.reload();
});
$("reactivateAccount")?.addEventListener("click", async () => {
  const { error } = await supabase.rpc("set_account_deactivated", { deactivate: false });
  if (error) return say(error.message, "accountSettingsMessage");
  location.reload();
});
$("deleteAccount")?.addEventListener("click", async () => {
  if (!confirm("Удалить аккаунт и связанные данные без возможности восстановления?")) return;
  const { error } = await supabase.functions.invoke("delete-account", { body: { confirm: true } });
  if (error) return say("Удаление не выполнено: " + error.message, "accountSettingsMessage");
  await supabase.auth.signOut(); location.reload();
});

$("profileForm")?.addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const username = $("editName").value.trim();

  if (username.length < 2) {
    return say("Имя должно содержать минимум 2 символа.");
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      username,
      bio: $("editBio").value.trim()
    })
    .eq("id", currentUser.id);

  if (error) return say(error.code === "23505" ? "Такое имя пользователя уже занято." : error.message);

  currentPresenceMode = $("editStatus").value;
  const { error: presenceError } = await supabase.from("profile_private").upsert({ user_id: currentUser.id, presence_mode: currentPresenceMode });
  if (presenceError) return say(presenceError.message);

  const { data: updatedProfile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (profileError) return say(profileError.message);

  currentProfile = updatedProfile;

  if ($("myName")) $("myName").textContent = currentProfile.username;

  if ($("topUser")) {
    $("topUser").textContent =
      currentProfile.username + " · " + roleLabel(currentProfile.role);
  }

  renderProfile();

  window.dispatchEvent(new CustomEvent("theapplebook:profile-updated"));

  say("Профиль сохранён.");
});

$("saveTheme")?.addEventListener("click", () => {
  const theme = $("themeSelect").value;

  localStorage.setItem("apple-theme", theme);

  document.body.classList.toggle("dark", theme === "dark");
  document.body.dataset.theme = theme;

  say("Тема сохранена.");
});

// =====================================
// ОБНОВЛЕНИЕ АВАТАРКИ ПОСЛЕ ИЗМЕНЕНИЯ
// =====================================

window.addEventListener("theapplebook:profile-updated", async () => {
  if (!currentUser) return;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error || !data) return;

  currentProfile = data;

  if ($("myAvatar")) {
    $("myAvatar").innerHTML = avatarContent(data);
  }

  if ($("myName")) {
    $("myName").textContent = data.username;
  }

  if ($("myStatus")) {
    $("myStatus").textContent = presenceLabel(currentPresenceMode);
  }

  renderProfile();

  const activePage = document.querySelector(".page:not(.hidden)");

  if (activePage?.id === "page-feed") await loadFeed();
  if (activePage?.id === "page-friends") await loadFriends();
  if (activePage?.id === "page-messages") await loadMessageContacts();
});

// =====================================
// АДМИНИСТРИРОВАНИЕ
// =====================================

async function loadAdmin() {
  if (!currentProfile || !$("adminContent")) return;

  if (!["owner", "ceo", "deputy_ceo", "admin"].includes(currentProfile.role)) {
    $("adminContent").textContent = "Недостаточно прав.";
    return;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id,username,role,avatar_url,avatar_emoji,handle")
    .order("username")
    .limit(100);

  if (error) return say(error.message);

  const canManageTop = currentProfile.role === "owner";

  $("adminContent").innerHTML = (data || []).map(person => {
    const options = canManageTop
      ? ["member", "moderator", "admin", "deputy_ceo", "ceo"]
      : ["member", "moderator", "admin"];

    const controls = person.role === "owner"
      ? `<span class="pill">OWNER — защищён</span>`
      : `
        <select data-role-select="${esc(person.id)}">
          ${options.map(role => `
            <option value="${role}" ${role === person.role ? "selected" : ""}>
              ${roleLabel(role)}
            </option>
          `).join("")}
        </select>

        <button class="secondary" data-role-save="${esc(person.id)}">
          Сохранить
        </button>
      `;

    return `
      <div class="result-row">

        <div class="person-main">
          ${renderAvatarButton(person)}

          <div class="user-info">
            <button
              type="button"
              class="person-name-button"
              data-profile-open="${esc(person.id)}"
            >
              ${esc(person.username)}
            </button>

            <small class="muted">${profileHandle(person)}</small>
            <small class="muted">${esc(roleLabel(person.role))}</small>
          </div>
        </div>

        <div>${controls}</div>

      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-role-save]").forEach(button => {
    button.addEventListener("click", async () => {
      const id = button.dataset.roleSave;

      const select = document.querySelector(
        `[data-role-select="${id}"]`
      );

      if (!select) return;

      const role = select.value;

      const { error } = await supabase.rpc("admin_set_role", {
        target_user_id: id,
        new_role: role
      });

      if (error) return say(error.message);

      say("Роль обновлена.");

      await boot();
      await loadAdmin();
    });
  });
}

// =====================================
// ЗАПУСК
// =====================================

boot();

// Private notes: database RLS restricts every row to its owner.
async function loadNotes() {
  if (!currentUser || !$("notesList")) return;
  const { data, error } = await supabase.from("notes").select("id,body,updated_at").order("updated_at", { ascending: false });
  if (error) return say("Не удалось загрузить Notes: " + error.message);
  const list = $("notesList");
  list.replaceChildren();
  for (const note of data || []) {
    const card = document.createElement("article");
    card.className = "panel pad";
    const body = document.createElement("p"); body.textContent = note.body;
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Изменить";
    edit.addEventListener("click", async () => {
      const updated = prompt("Изменить заметку", note.body);
      if (updated === null) return;
      const value = updated.trim();
      if (!value) return say("Заметка не может быть пустой.");
      const result = await supabase.from("notes").update({ body: value }).eq("id", note.id);
      if (result.error) return say(result.error.message);
      await loadNotes();
    });
    const del = document.createElement("button"); del.type = "button"; del.textContent = "Удалить";
    del.addEventListener("click", async () => {
      const result = await supabase.from("notes").delete().eq("id", note.id);
      if (result.error) return say(result.error.message);
      await loadNotes();
    });
    card.append(body, edit, del); list.append(card);
  }
}
$("noteForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const body = $("noteBody").value.trim();
  if (!body || !currentUser) return;
  const { error } = await supabase.from("notes").insert({ owner_id: currentUser.id, body });
  if (error) return say(error.message);
  $("noteBody").value = ""; await loadNotes();
});

async function loadGiftShopOnce() {
  const [{ data: wallet }, { data: gifts }, { data: history }] = await Promise.all([
    supabase.from("wallets").select("balance").eq("user_id", currentUser.id).maybeSingle(),
    supabase.from("gifts").select("id,name,rarity,price,emoji").order("price"),
    supabase.from("token_transactions").select("amount,kind,created_at,details").order("created_at", { ascending: false }).limit(15)
  ]);
  $("walletBalance").textContent = "💰 " + (wallet?.balance ?? 0) + " токенов";
  const catalog = $("giftCatalog"); catalog.replaceChildren();
  for (const gift of gifts || []) {
    const card = document.createElement("article"); card.className = "panel pad gift-card";
    const title = document.createElement("h3"); title.textContent = gift.emoji + " " + gift.name;
    const rarity = document.createElement("p"); rarity.textContent = gift.rarity + " · " + gift.price + " токенов";
    const send = document.createElement("button"); send.type = "button"; send.textContent = "Подарить";
    send.addEventListener("click", async () => {
      const username = $("giftRecipient").value.trim();
      if (!username) return $("giftMessage").textContent = "Введите имя получателя.";
      const normalizedUsername = username.trim().replace(/\s+/g, " ").toLowerCase();
      const { data: target, error: findError } = await supabase.from("profiles").select("id").eq("username_normalized", normalizedUsername).maybeSingle();
      if (findError || !target) return $("giftMessage").textContent = "Пользователь не найден.";
      const { error } = await supabase.rpc("send_gift", { target_user_id: target.id, selected_gift_id: gift.id });
      $("giftMessage").textContent = error ? error.message : "Подарок отправлен!";
      if (!error) await loadGiftShop();
    });
    card.append(title, rarity, send); catalog.append(card);
  }
  const log = $("tokenHistory"); log.replaceChildren();
  for (const item of history || []) {
    const row = document.createElement("p");
    row.textContent = (item.amount > 0 ? "+" : "") + item.amount + " · " + item.kind + " · " + formatTime(item.created_at);
    log.append(row);
  }
}

async function loadGiftShop() {
  if (!currentUser || !$("giftCatalog")) return;
  if (!giftLoadPromise) {
    giftLoadPromise = loadGiftShopOnce().finally(() => { giftLoadPromise = null; });
  }
  return giftLoadPromise;
}
$("claimDailyTokens")?.addEventListener("click", async () => {
  const { data, error } = await supabase.rpc("claim_daily_tokens");
  $("giftMessage").textContent = error ? error.message : "Ежедневные 250 токенов начислены.";
  if (!error) await loadGiftShop();
});

// Ежедневный бонус персонала доступен только ролям выше MEMBER.
// Проверка прав дополнительно выполняется на стороне базы данных.
const staffBonusButton = document.createElement("button");
staffBonusButton.id = "claimStaffTokens";
staffBonusButton.type = "button";
staffBonusButton.className = "secondary";
staffBonusButton.textContent = "Получить ежедневный бонус персонала";
staffBonusButton.hidden = true;
$("claimDailyTokens")?.insertAdjacentElement("afterend", staffBonusButton);

function updateStaffBonusVisibility() {
  staffBonusButton.hidden = !currentProfile || !isStaff(currentProfile.role);
}
updateStaffBonusVisibility();
window.addEventListener("theapplebook:profile-updated", updateStaffBonusVisibility);
staffBonusButton.addEventListener("click", async () => {
  if (!currentUser || !isStaff(currentProfile?.role)) return;
  staffBonusButton.disabled = true;
  const { error } = await supabase.rpc("admin_grant_self_tokens");
  $("giftMessage").textContent = error
    ? "Бонус не начислен: " + error.message
    : "Бонус персонала начислен.";
  staffBonusButton.disabled = false;
  if (!error) await loadGiftShop();
});
