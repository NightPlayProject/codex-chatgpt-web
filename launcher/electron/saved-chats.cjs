function savedChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname)
      || url.username || url.password || url.searchParams.has("temporary-chat")) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function rememberSavedChat(records, tab, now = new Date().toISOString()) {
  const url = tab.saveChat === true && savedChatUrl(tab.url);
  if (!url) return records;
  const entry = {
    url,
    title: typeof tab.pageTitle === "string" ? tab.pageTitle.slice(0, 200) : "ChatGPT",
    conversationKey: typeof tab.conversationKey === "string" ? tab.conversationKey.slice(0, 500) : null,
    updatedAt: now,
    connectorIdentity: tab.connectorIdentity ?? null,
    resume: tab.savedResume ?? null,
  };
  const previous = records.find(row => row.url === url);
  if (previous && previous.title === entry.title && previous.conversationKey === entry.conversationKey
    && JSON.stringify(previous.resume) === JSON.stringify(entry.resume)) return records;
  return [entry, ...records.filter(row => row.url !== url)].slice(0, 100);
}

function resumableSavedChat(records, key, connector, digest) {
  if (!key || !/^[a-f0-9]{64}$/.test(digest ?? "")) return null;
  const matches = records.filter(row => row.conversationKey === key && row.connectorIdentity === (connector ?? null)
    && savedChatUrl(row.url) && row.resume?.answerDigest === digest && typeof row.resume?.turnId === "string"
    && /^[a-zA-Z0-9_-]{1,200}$/.test(row.resume.turnId)
    && /^[a-f0-9]{64}$/.test(row.resume.domDigest ?? ""));
  return matches.length === 1 ? matches[0] : null;
}
module.exports = { savedChatUrl, rememberSavedChat, resumableSavedChat };
