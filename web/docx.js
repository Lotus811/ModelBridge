const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_TOTAL_XML_BYTES = 12 * 1024 * 1024;

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowerBound = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error("这不是有效的 DOCX 文件（找不到 ZIP 目录）");
}

function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder("utf-8");
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("DOCX 的 ZIP 目录已损坏");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({name, method, compressedSize, uncompressedSize, localOffset});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data, maxBytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 DOCX 解压，请升级 Chrome、Edge 或 Safari");
  }
  let stream;
  try {
    stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  } catch {
    throw new Error("当前浏览器无法解压 DOCX 内容");
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("DOCX 解压后的文本内容过大，可能是异常压缩文件");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error(`DOCX 条目损坏：${entry.name}`);
  }
  if (entry.uncompressedSize > MAX_DOCX_XML_BYTES) throw new Error("DOCX 文本内容过大");
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (dataOffset + entry.compressedSize > bytes.length) throw new Error(`DOCX 条目不完整：${entry.name}`);
  if (entry.method === 0) {
    if (compressed.byteLength > MAX_DOCX_XML_BYTES) throw new Error("DOCX 文本内容过大");
    return compressed;
  }
  if (entry.method === 8) return inflateRaw(compressed, MAX_DOCX_XML_BYTES);
  throw new Error(`DOCX 使用了不支持的压缩方式：${entry.method}`);
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.toLowerCase() === "amp") return "&";
    if (entity.toLowerCase() === "lt") return "<";
    if (entity.toLowerCase() === "gt") return ">";
    if (entity.toLowerCase() === "quot") return '"';
    if (entity.toLowerCase() === "apos") return "'";
    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : "";
  });
}

export function extractTextFromWordXml(xml) {
  const output = [];
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/?\s*>|<w:(?:br|cr)(?:\s[^>]*)?\/?\s*>|<\/w:(?:p|tr)>|<\/w:tc>/gi;
  let match;
  while ((match = tokenPattern.exec(xml))) {
    const token = match[0].toLowerCase();
    if (match[1] !== undefined) output.push(decodeXmlEntities(match[1]));
    else if (token.startsWith("<w:tab") || token === "</w:tc>") output.push("\t");
    else output.push("\n");
  }
  return output.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordPartPriority(name) {
  if (name === "word/document.xml") return 0;
  if (/^word\/header\d+\.xml$/i.test(name)) return 1;
  if (/^word\/footer\d+\.xml$/i.test(name)) return 2;
  if (name === "word/footnotes.xml") return 3;
  if (name === "word/endnotes.xml") return 4;
  return 10;
}

export async function extractDocxText(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const entries = listZipEntries(bytes)
    .filter(entry => entry.name === "word/document.xml" || /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(entry.name))
    .sort((a, b) => wordPartPriority(a.name) - wordPartPriority(b.name) || a.name.localeCompare(b.name));

  if (!entries.some(entry => entry.name === "word/document.xml")) {
    throw new Error("DOCX 中找不到正文内容，文件可能已损坏或加密");
  }

  const decoder = new TextDecoder("utf-8");
  const sections = [];
  let totalXmlBytes = 0;
  for (const entry of entries) {
    const xmlBytes = await readZipEntry(bytes, entry);
    totalXmlBytes += xmlBytes.byteLength;
    if (totalXmlBytes > MAX_DOCX_TOTAL_XML_BYTES) throw new Error("DOCX 可提取的文本内容总量过大，请拆分文档");
    const xml = decoder.decode(xmlBytes);
    const text = extractTextFromWordXml(xml);
    if (text) sections.push(text);
  }
  const result = sections.join("\n\n").trim();
  if (!result) throw new Error("DOCX 没有可提取的文字；扫描件请先转换为 PDF 或使用 OCR");
  if (result.length > 1_000_000) throw new Error("DOCX 提取后的文字超过 100 万字符，请拆分文档");
  return result;
}
