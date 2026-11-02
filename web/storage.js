const DATABASE_NAME = "modelbridge";
const DATABASE_VERSION = 1;
const CONVERSATION_STORE = "conversations";
const MESSAGE_STORE = "messages";
const MAX_TITLE_LENGTH = 52;
const MAX_SEARCH_PREVIEW = 12_000;

function textContent(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.displayContent === "string" && message.displayContent.trim()) return message.displayContent.trim();
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join(" ")
    .trim();
}

export function createConversationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveConversationTitle(messages) {
  const source = (Array.isArray(messages) ? messages : []).find(message => message?.role === "user" && textContent(message))
    || (Array.isArray(messages) ? messages : []).find(message => textContent(message));
  const compact = textContent(source).replace(/\s+/g, " ").trim();
  if (!compact) return "新对话";
  return compact.length > MAX_TITLE_LENGTH ? `${compact.slice(0, MAX_TITLE_LENGTH - 1)}…` : compact;
}

export function buildSearchPreview(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => textContent(message))
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase()
    .slice(0, MAX_SEARCH_PREVIEW);
}

export function buildConversationMetadata(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const timestamp = typeof options.updatedAt === "string" ? options.updatedAt : new Date().toISOString();
  return {
    id: String(options.id || createConversationId()),
    title: String(options.title || deriveConversationTitle(messages)).trim().slice(0, 120) || "新对话",
    createdAt: typeof options.createdAt === "string" ? options.createdAt : timestamp,
    updatedAt: timestamp,
    providerId: typeof options.providerId === "string" ? options.providerId : "",
    providerName: typeof options.providerName === "string" ? options.providerName.slice(0, 120) : "",
    model: typeof options.model === "string" ? options.model.slice(0, 300) : "",
    pinned: options.pinned === true,
    searchPreview: buildSearchPreview(messages)
  };
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {once: true});
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB 请求失败")), {once: true});
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), {once: true});
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB 事务已取消")), {once: true});
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB 事务失败")), {once: true});
  });
}

export function openConversationDatabase(factory = globalThis.indexedDB) {
  if (!factory?.open) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      const conversations = database.objectStoreNames.contains(CONVERSATION_STORE)
        ? request.transaction.objectStore(CONVERSATION_STORE)
        : database.createObjectStore(CONVERSATION_STORE, {keyPath: "id"});
      if (!conversations.indexNames.contains("updatedAt")) conversations.createIndex("updatedAt", "updatedAt");
      if (!conversations.indexNames.contains("pinned")) conversations.createIndex("pinned", "pinned");
      const messages = database.objectStoreNames.contains(MESSAGE_STORE)
        ? request.transaction.objectStore(MESSAGE_STORE)
        : database.createObjectStore(MESSAGE_STORE, {keyPath: "id"});
      if (!messages.indexNames.contains("conversationId")) messages.createIndex("conversationId", "conversationId");
    });
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => database.close());
      resolve(database);
    }, {once: true});
    request.addEventListener("blocked", () => reject(new Error("另一个页面阻止了对话数据库升级")), {once: true});
    request.addEventListener("error", () => reject(request.error || new Error("无法打开对话数据库")), {once: true});
  });
}

export class ConversationRepository {
  constructor(database) {
    this.database = database;
  }

  async list(query = "") {
    const transaction = this.database.transaction(CONVERSATION_STORE, "readonly");
    const completion = transactionDone(transaction);
    const records = await requestValue(transaction.objectStore(CONVERSATION_STORE).getAll());
    await completion;
    const needle = String(query).trim().toLocaleLowerCase();
    return records
      .filter(record => !needle || [record.title, record.providerName, record.model, record.searchPreview].some(value => String(value || "").toLocaleLowerCase().includes(needle)))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async load(id) {
    const transaction = this.database.transaction([CONVERSATION_STORE, MESSAGE_STORE], "readonly");
    const completion = transactionDone(transaction);
    const conversationRequest = transaction.objectStore(CONVERSATION_STORE).get(id);
    const messageRequest = transaction.objectStore(MESSAGE_STORE).index("conversationId").getAll(id);
    const [conversation, messages] = await Promise.all([requestValue(conversationRequest), requestValue(messageRequest)]);
    await completion;
    if (!conversation) return null;
    return {
      conversation,
      messages: messages.sort((left, right) => left.sequence - right.sequence).map(({id: _id, conversationId: _conversationId, sequence: _sequence, ...message}) => message)
    };
  }

  async save(metadata, messages) {
    const transaction = this.database.transaction([CONVERSATION_STORE, MESSAGE_STORE], "readwrite");
    const completion = transactionDone(transaction);
    transaction.objectStore(CONVERSATION_STORE).put(metadata);
    const messageStore = transaction.objectStore(MESSAGE_STORE);
    const keysRequest = messageStore.index("conversationId").getAllKeys(metadata.id);
    keysRequest.addEventListener("success", () => {
      for (const key of keysRequest.result) messageStore.delete(key);
      messages.forEach((message, sequence) => messageStore.put({
        ...message,
        id: `${metadata.id}:${String(sequence).padStart(4, "0")}`,
        conversationId: metadata.id,
        sequence
      }));
    }, {once: true});
    await completion;
    return metadata;
  }

  async update(id, patch) {
    const transaction = this.database.transaction(CONVERSATION_STORE, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(CONVERSATION_STORE);
    const record = await requestValue(store.get(id));
    if (!record) {
      transaction.abort();
      await completion.catch(() => {});
      throw new Error("对话不存在");
    }
    const updated = {...record, ...patch, id, updatedAt: patch.updatedAt || record.updatedAt};
    store.put(updated);
    await completion;
    return updated;
  }

  async delete(id) {
    const transaction = this.database.transaction([CONVERSATION_STORE, MESSAGE_STORE], "readwrite");
    const completion = transactionDone(transaction);
    transaction.objectStore(CONVERSATION_STORE).delete(id);
    const messageStore = transaction.objectStore(MESSAGE_STORE);
    const keysRequest = messageStore.index("conversationId").getAllKeys(id);
    keysRequest.addEventListener("success", () => {
      for (const key of keysRequest.result) messageStore.delete(key);
    }, {once: true});
    await completion;
  }

  close() {
    this.database.close();
  }
}

export async function createConversationRepository(factory = globalThis.indexedDB) {
  return new ConversationRepository(await openConversationDatabase(factory));
}
