import test from "node:test";
import assert from "node:assert/strict";
import {deflateRawSync} from "node:zlib";
import {extractDocxText, extractTextFromWordXml} from "../web/docx.js";

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const source = Buffer.from(file.content, "utf8");
    const data = file.compress === false ? source : deflateRawSync(source);
    const method = file.compress === false ? 0 : 8;
    const declaredSize = file.declaredSize ?? source.length;
    const localHeader = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(method), uint16(0), uint16(0),
      uint32(0), uint32(data.length), uint32(declaredSize), uint16(name.length), uint16(0), name
    ]);
    const centralHeader = Buffer.concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(method), uint16(0), uint16(0),
      uint32(0), uint32(data.length), uint32(declaredSize), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(localOffset), name
    ]);
    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(central.length), uint32(localOffset), uint16(0)
  ]);
  return Buffer.concat([...localParts, central, end]);
}

test("extracts readable text and structure from WordprocessingML", () => {
  const text = extractTextFromWordXml([
    '<w:p><w:r><w:t>Hello &amp; DOCX</w:t></w:r></w:p>',
    '<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:p><w:r><w:t>Line 1</w:t><w:br/><w:t>Line 2</w:t></w:r></w:p>'
  ].join(""));
  assert.match(text, /Hello & DOCX/);
  assert.match(text, /A1/);
  assert.match(text, /B1/);
  assert.match(text, /Line 1\nLine 2/);
});

test("extracts DOCX body, header, and footnotes from deflated ZIP entries", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Hello &amp; DOCX</w:t></w:r></w:p>
      <w:p><w:r><w:t>MB-DOCX-OK</w:t><w:tab/><w:t>Done</w:t></w:r></w:p>
    </w:body></w:document>`;
  const zip = makeZip([
    {name: "[Content_Types].xml", content: "<Types/>", compress: false},
    {name: "word/document.xml", content: documentXml},
    {name: "word/header1.xml", content: '<w:hdr><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>'},
    {name: "word/footnotes.xml", content: '<w:footnotes><w:p><w:r><w:t>Footnote text</w:t></w:r></w:p></w:footnotes>'}
  ]);
  const text = await extractDocxText(zip);
  assert.match(text, /Hello & DOCX/);
  assert.match(text, /MB-DOCX-OK\tDone/);
  assert.match(text, /Header text/);
  assert.match(text, /Footnote text/);
});

test("rejects archives that do not contain a DOCX document body", async () => {
  const zip = makeZip([{name: "word/header1.xml", content: "<w:hdr/>"}]);
  await assert.rejects(extractDocxText(zip), /找不到正文内容/);
});

test("rejects DOCX entries whose real inflated size exceeds the declared safe size", async () => {
  const oversizedXml = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(8 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
  const zip = makeZip([{name: "word/document.xml", content: oversizedXml, declaredSize: 128}]);
  await assert.rejects(extractDocxText(zip), /解压后的文本内容过大/);
});
