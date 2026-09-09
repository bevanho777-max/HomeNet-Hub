// Frontend language switch (zh / en) — purely per-viewer, never server state.
//
// Three rules shape this module:
//
//   1. ZH IS THE BASELINE AND MUST NOT MOVE. Every zh entry below is a verbatim copy
//      of the string it replaced, fullwidth punctuation and all. The switch is additive:
//      with lang=zh the page renders exactly what it rendered before this file existed.
//      That is why the dictionary is zh-first rather than an English source with a
//      Chinese translation layer — the translation direction decides which side is
//      allowed to drift, and it is not this one.
//   2. THE CHOICE LIVES IN localStorage, nowhere else. It never reaches /api/*, never
//      enters the config etag, and never changes what another viewer sees. A browser
//      that refuses storage still works; it just forgets on reload.
//   3. CONFIG LABELS ARE THE OPERATOR'S, NOT OURS. A YAML label may carry an `_en`
//      sibling (label_en / title_en / hint_en / columns_en / …). In en mode the sibling
//      wins; with no sibling the base value is used unchanged, so a half-translated
//      config degrades to mixed text rather than to blanks.
const KEY = 'hnh_lang';
const LANGS = ['zh', 'en'];

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return LANGS.includes(v) ? v : 'zh';
  } catch { return 'zh'; }   // privacy mode: default, and no exception on the boot path
}

let lang = read();
const listeners = new Set();

export const getLang = () => lang;
export const isEn = () => lang === 'en';

/** Register a callback fired after every language change (never on registration). */
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, lang); } catch { /* forgets on reload, still works now */ }
  applyDocumentLang();
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error('[i18n]', e); } }
}

/** `lang` on <html> — the value the document ships with in zh, so this is a no-op there. */
export function applyDocumentLang() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
}

// ── the dictionary ──────────────────────────────────────────────────
// A value is either a string or a function of the interpolated parts. Functions exist
// so a sentence can put its variable where its own grammar wants it, instead of forcing
// every language to use the Chinese word order.
const ZH = {
  // header / chrome
  btn_add_target: '＋ 添加目标',
  btn_credentials: '凭据',
  btn_clients: '客户端',
  btn_login: '管理登录',
  btn_passwd: '改密',
  btn_logout: '登出',
  btn_close: '关闭',
  lang_group: '语言',
  lang_zh: '中',
  lang_en: 'EN',

  // demo bar
  demo_text: '演示数据 —— 这些是示例机器,不是你的。',
  demo_add: '添加你的机器',
  demo_clear: '清空演示',
  demo_clear_locked: '清空演示(需登录)',
  demo_hide_title: '关闭这条提示',
  demo_clearing: '正在清空…',
  demo_confirm: '清空演示数据?\n\n示例机器与卡片会从这块板子上消失,只留下你自己添加的目标。'
    + '\n这个操作会保存在服务端,刷新后依然生效,并且没有撤销按钮 —— '
    + '要恢复演示板需要在服务器上清掉 settings 里的 demo_dismissed。',
  demo_expired: '会话已失效,请重新登录后再试。',
  demo_failed: '清空失败。',

  // empty board
  empty_title: '还没有目标',
  empty_hint_admin: '点右上角的「＋ 添加目标」来发现并添加你自己的机器。',
  empty_hint_guest: '先用右上角的「管理登录」登录,然后就能添加你自己的机器。',

  // shared
  cross_site: '请求被拒(跨站来源)。',
  req_failed: (e) => `请求失败:${e}`,
  too_many: (s) => `尝试过于频繁,请 ${s} 秒后再试。`,
  del: '删除',
  deleting: '删除中…',
  list_sep: '、',

  // first-run setup
  setup_title: '设置管理员密码',
  setup_pass_ph: '管理密码(至少 8 位)',
  setup_confirm_ph: '再输一次',
  setup_submit: '设置',
  setup_intro: '这台机器还没有管理员密码。设一个之后才能发现主机、添加目标与管理凭据。'
    + '只能在局域网里设,且只能设这一次。',
  setup_mismatch: '两次输入不一致,已清空重填。',
  setup_busy: '正在设置…',
  setup_done: '已设置,并且已登录。',
  setup_conflict: '这台机器已经配置过管理员了,请改用登录。',
  setup_lan_only: '设置管理员密码只能在局域网内完成。',
  setup_failed: '设置失败。',

  // login
  login_title: '管理登录',
  login_pass_ph: '管理密码',
  login_submit: '登录',
  login_need_pass: '请输入管理密码。',
  login_busy: '正在登录…',
  login_done: '已登录。',
  login_not_configured: '服务端没有配置 ADMIN_PASSWORD,管理功能不可用。',
  login_wrong: '密码错误。',
  login_wrong_limited: (s) => `密码错误,已触发限速,${s} 秒后可再试。`,
  login_failed: (e) => `登录请求失败:${e}`,
  login_hint_unconfigured: '服务端没有配置 ADMIN_PASSWORD —— 管理端点全部拒绝,登录也不会成功。',
  login_hint: '登录后才能发现主机、添加目标与管理凭据。',

  // change password
  passwd_title: '修改管理密码',
  passwd_current: '当前密码',
  passwd_new: '新密码',
  passwd_confirm: '确认新密码',
  passwd_new_ph: '至少 8 个字符',
  passwd_submit: '修改密码',
  passwd_note: '改密后,除当前这个标签页之外的所有已登录会话都会立即失效。',
  passwd_intro: '需要当前密码。改密会立即让其他所有已登录会话失效。',
  passwd_need_current: '请输入当前密码。',
  passwd_need_new: '请输入新密码。',
  passwd_mismatch: '两次输入的新密码不一致,已清空重填。',
  passwd_busy: '正在修改…',
  passwd_done: '密码已修改。本标签页仍然登录,其他会话已全部失效。',
  passwd_bad_current: '当前密码不正确。',
  passwd_bad_current_limited: (s) => `当前密码不正确,已触发限速,${s} 秒后可再试。`,
  passwd_session_lost: '会话已失效,请重新登录。',
  passwd_failed: '修改失败。',

  // credentials
  cred_title: '凭据',
  cred_locked_head: '未配置 VAULT_KEY',
  cred_locked_why: (why) => `金库锁定,无法存取凭据(${why})。`,
  cred_locked_fix: '在宿主机的 compose 环境里设置 VAULT_KEY 后重启容器即可。',
  cred_name: '名称',
  cred_type: '类型',
  cred_user: '用户名',
  cred_secret: '密钥 / 密码',
  cred_secret_ph: '存入后不可读出',
  cred_save: '加密保存',
  cred_section: '已存凭据',
  cred_type_ssh_password: 'SSH 密码',
  cred_type_ssh_key: 'SSH 私钥',
  cred_type_winrm_password: 'WinRM 密码',
  cred_unconfigured: '未配置',
  cred_empty: '还没有存过凭据。',
  cred_list_failed: '凭据列表加载失败',
  cred_need_fields: '名称、用户名、密钥都要填。',
  cred_busy: '正在加密并保存…',
  cred_vault_off: (why) => `金库未配置:${why}`,
  cred_dup: (name) => `已存在同名凭据「${name}」`,
  cred_save_failed: (why) => `保存失败:${why}`,
  cred_saved: (name) => `已加密保存「${name}」—— 密钥本身此后无法再读出。`,
  cred_del_confirm: (name) => `删除凭据「${name}」?\n它无法恢复,引用它的目标会失效。`,
  cred_in_use: (name, list) => `「${name}」正在被这些目标使用:${list}`,
  cred_deleted: (name) => `已删除「${name}」`,
  cred_del_failed: (e) => `删除失败:${e}`,
  cred_intro: '密钥加密后存入本机数据库,存进去就再也读不出来 —— 只能改名重存或删除。',

  // clients (litellm virtual keys)
  cli_title: '客户端',
  cli_off_head: '未配置 LITELLM_MASTER_KEY',
  // 注意那个空格:改前这句在 index.html 里跨了两行,HTML 把换行折叠成一个空格,
  // 所以页面上一直是「),␣无法」。zh 基线照抄现状,不趁 i18n 顺手改版式。
  cli_off_why: (why) => `连不上 litellm 的 key 接口(${why}), 无法新建或撤销客户端 key。`,
  cli_off_fix: '在宿主机 .env 里设 LITELLM_MASTER_KEY 后 <code>docker compose up -d</code> '
    + '重建容器即可。用量卡不受影响,只是显示短哈希而不是名字。',
  cli_name: '名字',
  cli_create: '创建 key',
  cli_new_head: '这是唯一一次显示这把 key',
  cli_new_warn: '关掉这个框就再也拿不回来了 —— litellm 只保存它的摘要。',
  cli_copy: '复制',
  cli_section: '客户端与用量',
  cli_unconfigured: '未配置',
  cli_api_down: (e) => `litellm 的 key 接口没响应:${e}`,
  cli_system: '网关自己的 key',
  cli_revoked: '已撤销',
  cli_usage: (tok, net, reqs) => `${tok} tok · 净 ${net} · ${reqs} 次`,
  cli_today: (n) => `今日 ${n} 次`,
  cli_empty: '还没有客户端 key。',
  cli_unattributed: (keys, reqs) => `另有 ${keys} 个无法归属的 key 值(鉴权失败/扫描噪声),`
    + `共 ${reqs} 次请求 —— 出于安全不显示内容。`,
  cli_list_failed: '客户端列表加载失败',
  cli_need_name: '给这个客户端起个名字,比如 openclaw。',
  cli_busy: '正在向 litellm 申请…',
  cli_key_api_off: (why) => `litellm key 接口未配置:${why}`,
  cli_dup: (name) => `已经有叫「${name}」的客户端了。`,
  cli_create_failed: (why) => `创建失败:${why}`,
  cli_created: (name) => `已创建「${name}」—— 把下面这把 key 配到客户端里。`,
  cli_del_confirm: (name) => `撤销客户端「${name}」的 key?\n用它的客户端会立刻 401,历史用量仍会留在卡上。`,
  cli_revoking: '撤销中…',
  cli_revoked_ok: (name) => `已撤销「${name}」`,
  cli_revoke_failed: (e) => `撤销失败:${e}`,
  cli_copied: '已复制到剪贴板。',
  cli_copy_manual: '浏览器不允许自动复制(需要 https),已帮你选中,按 Ctrl+C。',
  cli_intro: '每个客户端一把 key。卡上的用量按这里的名字归属,撤销后历史用量仍然保留。',

  // add target
  add_title: '添加目标',
  add_host_ph: '192.168.1.x（仅限私网地址）',
  add_discover: '发现',
  add_selected: '添加所选',
  add_selected_n: (n) => `添加所选 (${n})`,
  add_section: '已添加',
  add_intro: '输入一个私网 IP,点"发现"看看那台机器上有什么。',
  add_need_ip: '请输入一个 IP 地址',
  add_ipv4_only: '只支持 IPv4 地址,例如 192.168.1.24',
  add_leading_zero: '八位组不能有前导零(0 开头会被当作八进制)',
  add_octet_range: '每一段必须在 0-255 之间',
  add_link_local: '链路本地地址(169.254.x.x)不允许探测',
  add_private_only: '只能探测私网地址:10.x / 172.16-31.x / 192.168.x',
  add_reason_private: '只能探测私网地址(10.x / 172.16-31.x / 192.168.x)',
  add_reason_link_local: '链路本地地址(169.254.x.x)不允许探测',
  add_reason_leading_zero: '八位组不能有前导零',
  add_reason_not_ipv4: '不是合法的 IPv4 地址',
  add_reason_port: '该端口不在已知端口集内',
  add_reason_pending: '该能力的采集器尚未实现',
  add_reason_tls: '这是 TLS 端口,请改用 TLS 证书能力',
  add_probing: (host) => `正在探测 ${host} …`,
  add_refused: (why) => `探测被拒绝:${why}`,
  add_probe_ok: (ms, n) => `探测完成,用时 ${ms}ms,可添加 ${n} 项`,
  add_probe_silent: (host) => `${host} 没有响应(端口全关或主机离线),仍可添加可达性监控`,
  add_probe_failed: (e) => `探测失败:${e}`,
  add_group_service: '服务与端口',
  add_group_info: '证书与信息',
  add_group_machine: '机器指标',
  add_no_vault: '金库未配置,无法使用凭据',
  add_no_creds: '先去「凭据」面板添加一个 SSH 凭据',
  add_needs_ssh: '需要 SSH 凭据',
  add_needs_winrm: '需要 WinRM 凭据',
  add_needs_collector: '需要采集器(切片 2d)',
  add_none: '无',
  add_reachable: '可达',
  add_silent: '无响应',
  add_cert_days: (d) => `证书 ${d} 天`,
  add_open_ports: '开放端口',
  add_services: '服务',
  add_custom_name_ph: '自定义名称(可选)',
  add_adding: '添加中…',
  add_added: '已添加',
  add_exists: '已存在',
  add_added_n: (n) => `已添加 ${n} 项,看板已刷新`,
  add_manual: '手动',
  add_list_empty: '还没有通过发现添加的目标。',
  add_list_failed: '已添加列表加载失败',
  add_del_confirm: (id) => `删除 "${id}" ?\n它的卡片和历史采样将停止。`,
  add_deleted: (id) => `已删除 ${id}`,
  add_del_failed: (e) => `删除失败:${e}`,

  // history / detail charts
  chart_retry: '重试',
  chart_render_failed: (e) => `渲染失败：${e}`,
  chart_timeout: (range) => `加载超时（${range}）`,
  chart_load_failed: (e) => `加载失败：${e}`,
  chart_no_data_range: (range) => `该时段无数据（${range}）`,
  chart_never_recorded: (names) => `${names}：未记录历史`,
  chart_none_in_range: (names) => `${names}：该时段无数据`,
  chart_note_sep: '　',

  // table card
  table_more: '查看全部',
  table_count: (n) => `（共 ${n}）`,
  table_title_count: (title, n) => `${title}（共 ${n}）`,
};

const EN = {
  btn_add_target: '+ Add target',
  btn_credentials: 'Credentials',
  btn_clients: 'Clients',
  btn_login: 'Admin login',
  btn_passwd: 'Password',
  btn_logout: 'Log out',
  btn_close: 'Close',
  lang_group: 'Language',
  lang_zh: '中',
  lang_en: 'EN',

  demo_text: 'Demo data — these are sample machines, not yours.',
  demo_add: 'Add your machines',
  demo_clear: 'Clear demo',
  demo_clear_locked: 'Clear demo (login required)',
  demo_hide_title: 'Dismiss this notice',
  demo_clearing: 'Clearing…',
  demo_confirm: 'Clear the demo data?\n\nThe sample machines and cards leave this board, '
    + 'keeping only the targets you added yourself.'
    + '\nThis is saved on the server, survives a reload, and has no undo button — '
    + 'restoring the demo board means clearing demo_dismissed from settings on the server.',
  demo_expired: 'Session expired — log in again and retry.',
  demo_failed: 'Clearing failed.',

  empty_title: 'No targets yet',
  empty_hint_admin: 'Use "+ Add target" at the top right to discover and add your own machines.',
  empty_hint_guest: 'Log in with "Admin login" at the top right, then you can add your own machines.',

  cross_site: 'Request refused (cross-site origin).',
  req_failed: (e) => `Request failed: ${e}`,
  too_many: (s) => `Too many attempts — try again in ${s}s.`,
  del: 'Delete',
  deleting: 'Deleting…',
  list_sep: ', ',

  setup_title: 'Set the admin password',
  setup_pass_ph: 'Admin password (8 characters minimum)',
  setup_confirm_ph: 'Type it again',
  setup_submit: 'Set',
  setup_intro: 'This machine has no admin password yet. Setting one is what unlocks host '
    + 'discovery, adding targets and managing credentials. It can only be set from the LAN, '
    + 'and only once.',
  setup_mismatch: 'The two entries do not match — both cleared, please retype.',
  setup_busy: 'Setting…',
  setup_done: 'Set, and you are logged in.',
  setup_conflict: 'This machine already has an admin configured — use the login instead.',
  setup_lan_only: 'The admin password can only be set from inside the LAN.',
  setup_failed: 'Setup failed.',

  login_title: 'Admin login',
  login_pass_ph: 'Admin password',
  login_submit: 'Log in',
  login_need_pass: 'Enter the admin password.',
  login_busy: 'Logging in…',
  login_done: 'Logged in.',
  login_not_configured: 'The server has no ADMIN_PASSWORD configured; admin features are unavailable.',
  login_wrong: 'Wrong password.',
  login_wrong_limited: (s) => `Wrong password — rate limit tripped, retry in ${s}s.`,
  login_failed: (e) => `Login request failed: ${e}`,
  login_hint_unconfigured: 'The server has no ADMIN_PASSWORD configured — every admin endpoint '
    + 'refuses, so logging in cannot succeed either.',
  login_hint: 'Log in to discover hosts, add targets and manage credentials.',

  passwd_title: 'Change the admin password',
  passwd_current: 'Current password',
  passwd_new: 'New password',
  passwd_confirm: 'Confirm new password',
  passwd_new_ph: 'At least 8 characters',
  passwd_submit: 'Change password',
  passwd_note: 'Changing it immediately invalidates every logged-in session except this tab.',
  passwd_intro: 'The current password is required. Changing it immediately invalidates every '
    + 'other logged-in session.',
  passwd_need_current: 'Enter the current password.',
  passwd_need_new: 'Enter the new password.',
  passwd_mismatch: 'The two new passwords do not match — both cleared, please retype.',
  passwd_busy: 'Changing…',
  passwd_done: 'Password changed. This tab stays logged in; every other session is gone.',
  passwd_bad_current: 'The current password is not correct.',
  passwd_bad_current_limited: (s) => `The current password is not correct — rate limit tripped, retry in ${s}s.`,
  passwd_session_lost: 'Session expired — please log in again.',
  passwd_failed: 'The change failed.',

  cred_title: 'Credentials',
  cred_locked_head: 'VAULT_KEY not configured',
  cred_locked_why: (why) => `The vault is locked; credentials cannot be stored or used (${why}).`,
  cred_locked_fix: 'Set VAULT_KEY in the compose environment on the host and restart the container.',
  cred_name: 'Name',
  cred_type: 'Type',
  cred_user: 'Username',
  cred_secret: 'Key / password',
  cred_secret_ph: 'Write-only once stored',
  cred_save: 'Encrypt and save',
  cred_section: 'Stored credentials',
  cred_type_ssh_password: 'SSH password',
  cred_type_ssh_key: 'SSH private key',
  cred_type_winrm_password: 'WinRM password',
  cred_unconfigured: 'not configured',
  cred_empty: 'No credentials stored yet.',
  cred_list_failed: 'Could not load the credential list',
  cred_need_fields: 'Name, username and secret are all required.',
  cred_busy: 'Encrypting and saving…',
  cred_vault_off: (why) => `Vault not configured: ${why}`,
  cred_dup: (name) => `A credential named "${name}" already exists`,
  cred_save_failed: (why) => `Save failed: ${why}`,
  cred_saved: (name) => `Saved "${name}" encrypted — the secret itself can never be read back.`,
  cred_del_confirm: (name) => `Delete the credential "${name}"?\nIt cannot be recovered, and targets referencing it will break.`,
  cred_in_use: (name, list) => `"${name}" is in use by these targets: ${list}`,
  cred_deleted: (name) => `Deleted "${name}"`,
  cred_del_failed: (e) => `Delete failed: ${e}`,
  cred_intro: 'The secret is encrypted into this machine’s database and can never be read '
    + 'back out — only renamed, re-stored or deleted.',

  cli_title: 'Clients',
  cli_off_head: 'LITELLM_MASTER_KEY not configured',
  cli_off_why: (why) => `Cannot reach the litellm key API (${why}), so client keys cannot be minted or revoked.`,
  cli_off_fix: 'Set LITELLM_MASTER_KEY in .env on the host, then <code>docker compose up -d</code> '
    + 'to rebuild the container. The usage cards are unaffected — they just show a short hash '
    + 'instead of a name.',
  cli_name: 'Name',
  cli_create: 'Create key',
  cli_new_head: 'This is the only time this key is shown',
  cli_new_warn: 'Close this box and it is gone for good — litellm keeps only its digest.',
  cli_copy: 'Copy',
  cli_section: 'Clients and usage',
  cli_unconfigured: 'not configured',
  cli_api_down: (e) => `The litellm key API did not answer: ${e}`,
  cli_system: 'the gateway’s own key',
  cli_revoked: 'revoked',
  cli_usage: (tok, net, reqs) => `${tok} tok · net ${net} · ${reqs} reqs`,
  cli_today: (n) => `${n} today`,
  cli_empty: 'No client keys yet.',
  cli_unattributed: (keys, reqs) => `Another ${keys} key value(s) could not be attributed `
    + `(failed auth / scanner noise), ${reqs} requests in total — their content is withheld.`,
  cli_list_failed: 'Could not load the client list',
  cli_need_name: 'Give this client a name, e.g. openclaw.',
  cli_busy: 'Asking litellm…',
  cli_key_api_off: (why) => `The litellm key API is not configured: ${why}`,
  cli_dup: (name) => `There is already a client called "${name}".`,
  cli_create_failed: (why) => `Creation failed: ${why}`,
  cli_created: (name) => `Created "${name}" — put the key below into that client.`,
  cli_del_confirm: (name) => `Revoke the key for client "${name}"?\nAnything using it gets a 401 immediately; its past usage stays on the card.`,
  cli_revoking: 'Revoking…',
  cli_revoked_ok: (name) => `Revoked "${name}"`,
  cli_revoke_failed: (e) => `Revoke failed: ${e}`,
  cli_copied: 'Copied to the clipboard.',
  cli_copy_manual: 'The browser will not copy automatically (that needs https). '
    + 'The key is selected for you — press Ctrl+C.',
  cli_intro: 'One key per client. Usage on the cards is attributed by the names here, and past '
    + 'usage survives a revoke.',

  add_title: 'Add target',
  add_host_ph: '192.168.1.x (private addresses only)',
  add_discover: 'Discover',
  add_selected: 'Add selected',
  add_selected_n: (n) => `Add selected (${n})`,
  add_section: 'Added',
  add_intro: 'Type a private IP and hit "Discover" to see what is on that machine.',
  add_need_ip: 'Enter an IP address',
  add_ipv4_only: 'IPv4 addresses only, e.g. 192.168.1.24',
  add_leading_zero: 'Octets cannot have a leading zero (a leading 0 reads as octal)',
  add_octet_range: 'Every octet must be between 0 and 255',
  add_link_local: 'Link-local addresses (169.254.x.x) cannot be probed',
  add_private_only: 'Only private addresses can be probed: 10.x / 172.16-31.x / 192.168.x',
  add_reason_private: 'Only private addresses can be probed (10.x / 172.16-31.x / 192.168.x)',
  add_reason_link_local: 'Link-local addresses (169.254.x.x) cannot be probed',
  add_reason_leading_zero: 'Octets cannot have a leading zero',
  add_reason_not_ipv4: 'Not a valid IPv4 address',
  add_reason_port: 'That port is not in the known port set',
  add_reason_pending: 'The collector for this capability is not implemented yet',
  add_reason_tls: 'That is a TLS port — use the TLS certificate capability instead',
  add_probing: (host) => `Probing ${host} …`,
  add_refused: (why) => `Probe refused: ${why}`,
  add_probe_ok: (ms, n) => `Probe done in ${ms}ms, ${n} item(s) can be added`,
  add_probe_silent: (host) => `${host} did not answer (every port closed, or the host is offline); reachability monitoring can still be added`,
  add_probe_failed: (e) => `Probe failed: ${e}`,
  add_group_service: 'Services and ports',
  add_group_info: 'Certificates and info',
  add_group_machine: 'Machine metrics',
  add_no_vault: 'Vault not configured — credentials unavailable',
  add_no_creds: 'Add an SSH credential in the "Credentials" panel first',
  add_needs_ssh: 'Needs an SSH credential',
  add_needs_winrm: 'Needs a WinRM credential',
  add_needs_collector: 'Needs a collector (slice 2d)',
  add_none: 'none',
  add_reachable: 'reachable',
  add_silent: 'no answer',
  add_cert_days: (d) => `cert ${d}d`,
  add_open_ports: 'Open ports',
  add_services: 'Services',
  add_custom_name_ph: 'Custom name (optional)',
  add_adding: 'Adding…',
  add_added: 'Added',
  add_exists: 'Already there',
  add_added_n: (n) => `Added ${n} item(s); the board has refreshed`,
  add_manual: 'manual',
  add_list_empty: 'Nothing has been added through discovery yet.',
  add_list_failed: 'Could not load the added list',
  add_del_confirm: (id) => `Delete "${id}"?\nIts card and history sampling will stop.`,
  add_deleted: (id) => `Deleted ${id}`,
  add_del_failed: (e) => `Delete failed: ${e}`,

  chart_retry: 'Retry',
  chart_render_failed: (e) => `Render failed: ${e}`,
  chart_timeout: (range) => `Load timed out (${range})`,
  chart_load_failed: (e) => `Load failed: ${e}`,
  chart_no_data_range: (range) => `No data in this window (${range})`,
  chart_never_recorded: (names) => `${names}: never recorded`,
  chart_none_in_range: (names) => `${names}: no data in this window`,
  chart_note_sep: '   ',

  table_more: 'View all',
  table_count: (n) => ` (${n} total)`,
  table_title_count: (title, n) => `${title} (${n} total)`,
};

const DICT = { zh: ZH, en: EN };

/**
 * Look up a UI string. Missing en entries fall back to zh rather than to the key, so an
 * incomplete translation shows the original sentence instead of `cli_revoke_failed`.
 */
export function t(key, ...args) {
  const v = DICT[lang]?.[key] ?? ZH[key];
  if (v == null) return key;
  return typeof v === 'function' ? v(...args) : v;
}

// ── config-label resolution ─────────────────────────────────────────
/**
 * A scalar label from config, with its `_en` sibling preferred in en mode.
 * An empty string counts as absent: a YAML `title_en: ""` means "not translated",
 * not "render nothing".
 */
export function cv(obj, field) {
  if (!obj) return undefined;
  if (lang === 'en') {
    const en = obj[`${field}_en`];
    if (en != null && en !== '') return en;
  }
  return obj[field];
}

/** A flat label map (layout.text, token `labels`), overlaid per key by `<field>_en`. */
export function cmap(obj, field) {
  const base = obj?.[field] || {};
  if (lang !== 'en') return base;
  const en = obj?.[`${field}_en`];
  return (en && typeof en === 'object') ? { ...base, ...en } : base;
}

/**
 * An ordered column map (`columns` / `detail_columns`) → { key: { label, format } }.
 *
 * Two ways to translate one, both accepted because they suit different files:
 *   - `label_en` inside an entry's object form — keeps the translation next to the
 *     format it belongs to, which is what a hand-edited config wants;
 *   - a parallel `<field>_en` map — lets a whole card be translated in one block.
 * The parallel map wins where both exist. Its values may be a bare string (label only,
 * base `format` kept) or an object (merged over the base entry), so translating a label
 * can never silently drop the format that makes the number readable.
 */
export function colmap(obj, field) {
  const base = obj?.[field] || {};
  const en = lang === 'en' ? obj?.[`${field}_en`] : null;
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    const b = (typeof v === 'string') ? { label: v } : (v || {});
    let label = b.label ?? k;
    let format = b.format ?? null;
    if (lang === 'en') {
      if (b.label_en != null && b.label_en !== '') label = b.label_en;
      const ov = en ? en[k] : undefined;
      if (typeof ov === 'string') { if (ov !== '') label = ov; }
      else if (ov && typeof ov === 'object') {
        if (ov.label != null && ov.label !== '') label = ov.label;
        if (ov.format != null) format = ov.format;
      }
    }
    out[k] = { label, format };
  }
  return out;
}

// ── static chrome in index.html ─────────────────────────────────────
// The markup ships with the Chinese text inline, so the page reads correctly before this
// module runs and the zh pass below writes back exactly what is already there. Only the
// en pass actually changes anything.
const ATTRS = [
  ['data-i18n', (el, s) => { el.textContent = s; }],
  ['data-i18n-html', (el, s) => { el.innerHTML = s; }],
  ['data-i18n-ph', (el, s) => { el.setAttribute('placeholder', s); }],
  ['data-i18n-title', (el, s) => { el.setAttribute('title', s); }],
  ['data-i18n-aria', (el, s) => { el.setAttribute('aria-label', s); }],
];

/** Re-apply every `data-i18n*` string in the document. Idempotent. */
export function applyStaticText(root = document) {
  for (const [attr, set] of ATTRS) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr);
      if (key) set(el, t(key));
    });
  }
}
