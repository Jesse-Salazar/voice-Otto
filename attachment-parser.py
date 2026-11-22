"""Read-only text extraction worker. Input bytes and output JSON travel over pipes."""

import io
import json
import posixpath
import re
import resource
import sys
import zipfile

MAX_BYTES = 8 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_SECTIONS = 60
MAX_BLOCKS = 2500
MAX_TEXT = 120_000
MAX_GRID_CELLS = 40_000


class Rejected(Exception):
    pass


class Document:
    def __init__(self, warnings=None):
        self.warnings = warnings or []
        self.sections = []
        self.count = 0
        self.size = 0

    def section(self, **metadata):
        if len(self.sections) >= MAX_SECTIONS:
            raise Rejected("Section or page limit exceeded")
        section = {**metadata, "blocks": []}
        self.sections.append(section)
        return section

    def block(self, section, text, **metadata):
        if not text.strip():
            return
        self.count += 1
        self.size += len(text)
        if self.count > MAX_BLOCKS or self.size > MAX_TEXT:
            raise Rejected("Extracted text or block limit exceeded")
        section["blocks"].append({**metadata, "text": text})

    def report(self):
        return {"sections": self.sections, "warnings": list(dict.fromkeys(self.warnings))}


def open_package(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    try:
        entries = archive.infolist()
        names = {entry.filename for entry in entries}
        if len(entries) > 600 or len(names) != len(entries):
            raise Rejected("Office archive has too many or duplicate entries")
        if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
            raise Rejected("Office archive expansion limit exceeded")
        for entry in entries:
            name = entry.filename
            if (name.startswith("/") or "\\" in name or ".." in name.split("/") or
                    entry.flag_bits & 1 or entry.file_size > MAX_XML or
                    (entry.file_size > 65536 and entry.file_size > 250 * max(entry.compress_size, 1))):
                raise Rejected("Unsafe, encrypted, or oversized Office archive member")
            if "vbaproject" in name.lower() or "/activex/" in name.lower():
                raise Rejected("Macro or ActiveX Office archive is unsupported")
        return archive
    except Exception:
        archive.close()
        raise


def xml(archive, name):
    from defusedxml.ElementTree import fromstring
    return fromstring(archive.read(name), forbid_dtd=True, forbid_entities=True, forbid_external=True)


XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DOCX_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def xlsx(data):
    ns = XLSX_NS
    doc = Document()
    with open_package(data) as archive:
        workbook = xml(archive, "xl/workbook.xml")
        relations = xml(archive, "xl/_rels/workbook.xml.rels")
        rels = {relation.get("Id"): relation for relation in relations.findall(REL_NS + "Relationship")}
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = xml(archive, "xl/sharedStrings.xml")
            strings = ["".join(item.text or "" for item in node.iter(ns + "t")) for node in shared.findall(ns + "si")]
        sheets = workbook.findall(f"{ns}sheets/{ns}sheet")
        if not sheets:
            raise Rejected("Workbook contains no worksheets")
        cells = 0
        seen = set()
        for sheet in sheets:
            relation = rels.get(sheet.get(REL_ID))
            if relation is None or relation.get("TargetMode") == "External":
                raise Rejected("Invalid or external worksheet relationship")
            target = relation.get("Target", "")
            endpoint = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
            if not endpoint.startswith("xl/worksheets/") or not endpoint.endswith(".xml") or endpoint in seen:
                raise Rejected("Unsupported or duplicate worksheet relationship")
            seen.add(endpoint)
            section = doc.section(kind="worksheet", name=sheet.get("name", ""), visibility=sheet.get("state", "visible"))
            root = xml(archive, endpoint)
            for cell in root.iter(ns + "c"):
                cells += 1
                if cells > MAX_GRID_CELLS:
                    raise Rejected("Worksheet cell limit exceeded")
                coordinate = cell.get("r", "")
                if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", coordinate):
                    raise Rejected("Unsupported worksheet cell coordinate")
                if cell.find(ns + "f") is not None:
                    doc.warnings.append("Formula cells were skipped; formulas and links were not evaluated.")
                    continue
                if cell.get("t") == "inlineStr":
                    text = "".join(item.text or "" for item in cell.iter(ns + "t"))
                else:
                    text = cell.findtext(ns + "v", "")
                    if cell.get("t") == "s":
                        if not text.isdigit() or int(text) >= len(strings):
                            raise Rejected("Invalid workbook shared string reference")
                        text = strings[int(text)]
                doc.block(section, text, location=coordinate)
    return doc


def xls(data):
    import xlrd
    if not data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        raise Rejected("Expected an Excel compound-document workbook")
    doc = Document(["Legacy workbook values are cached; formulas and links were not evaluated."])
    workbook = xlrd.open_workbook(file_contents=data, on_demand=True, ragged_rows=True)
    try:
        if not 0 < workbook.nsheets <= MAX_SECTIONS:
            raise Rejected("Worksheet count is unsupported")
        cells = 0
        for sheet_index in range(workbook.nsheets):
            sheet = workbook.sheet_by_index(sheet_index)
            section = doc.section(kind="worksheet", name=sheet.name, visibility="hidden" if sheet.visibility else "visible")
            for row in range(sheet.nrows):
                values = sheet.row_values(row)
                cells += len(values)
                if cells > MAX_GRID_CELLS:
                    raise Rejected("Worksheet cell limit exceeded")
                for column, value in enumerate(values):
                    doc.block(section, str(value), location=cell_address(column, row))
            workbook.unload_sheet(sheet_index)
    finally:
        workbook.release_resources()
    return doc


def cell_address(column, row):
    letters = ""
    while column >= 0:
        letters = chr(65 + column % 26) + letters
        column = column // 26 - 1
    return f"{letters}{row + 1}"


def docx(data):
    ns = DOCX_NS
    doc = Document()
    with open_package(data) as archive:
        root = xml(archive, "word/document.xml")
        body = root.find(ns + "body")
        if body is None:
            raise Rejected("Document body is missing")
        section = doc.section(kind="document", name="Body")

        def text_of(node):
            parts = []
            for element in node.iter():
                if element.tag == ns + "t":
                    parts.append(element.text or "")
                elif element.tag in (ns + "br", ns + "cr"):
                    parts.append("\f" if element.get(ns + "type") == "page" else "\n")
                elif element.tag == ns + "tab":
                    parts.append("\t")
            return "".join(parts)

        for index, block in enumerate(body, 1):
            if block.tag == ns + "p":
                doc.block(section, text_of(block), kind="paragraph", location=f"Paragraph {index}")
            elif block.tag == ns + "tbl":
                for row, element in enumerate(block.findall(ns + "tr"), 1):
                    for col, cell in enumerate(element.findall(ns + "tc"), 1):
                        text = "\n".join(text_of(p) for p in cell.iter(ns + "p"))
                        doc.block(section, text, kind="table-cell", location=f"Table {index}, row {row}, column {col}")
            elif block.tag != ns + "sectPr":
                doc.warnings.append("Unsupported document content was skipped.")
    return doc


def pdf(data):
    from pypdf import PdfReader
    if not data.startswith(b"%PDF-"):
        raise Rejected("Expected a PDF header")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise Rejected("Encrypted PDFs are unsupported")
    if not 0 < len(reader.pages) <= MAX_SECTIONS:
        raise Rejected("PDF page limit exceeded")
    doc = Document()
    for number, page in enumerate(reader.pages, 1):
        section = doc.section(kind="page", page=number)
        for index, line in enumerate((page.extract_text() or "").splitlines(), 1):
            doc.block(section, line, location=f"Line {index}")
    if not doc.count:
        doc.warnings.append("No selectable PDF text was found; OCR is not performed.")
    return doc


def txt(data):
    text = data.decode("utf-8-sig")
    if any(ord(char) < 32 and char not in "\t\n\r\f" for char in text):
        raise Rejected("Text contains binary control characters")
    doc = Document()
    section = doc.section(kind="text", name="Plain text")
    for number, line in enumerate(text.splitlines(), 1):
        doc.block(section, line, location=f"Line {number}")
    return doc


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (8, 9))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    parsers = {"xlsx": xlsx, "xls": xls, "docx": docx, "pdf": pdf, "txt": txt}
    if len(sys.argv) != 2 or sys.argv[1] not in parsers:
        raise Rejected("Unsupported attachment format")
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise Rejected("Attachment is empty or exceeds the size limit")
    report = parsers[sys.argv[1]](data).report()
    sys.stdout.write(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Rejected as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except ImportError:
        print("Attachment parser dependencies are unavailable", file=sys.stderr)
        sys.exit(2)
    except Exception:
        print("Malformed, encrypted, or unsupported attachment", file=sys.stderr)
        sys.exit(2)
