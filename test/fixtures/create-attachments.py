"""Build synthetic attachment fixtures in a caller-provided temporary directory."""

from pathlib import Path
import sys
from zipfile import ZipFile
import xlwt

directory = Path(sys.argv[1])
workbook = '''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets><sheet name="Recording Script" sheetId="1" r:id="rId1"/>
 <sheet name="Instructions" sheetId="2" r:id="rId2"/></sheets></workbook>'''
rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
 <Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'''
sheet = '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2">
 <c r="B2" t="inlineStr"><is><t>Narrator: The lighthouse is still shining.</t></is></c>
 <c r="C2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'''
sheet2 = '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Instructions: Please record in a quiet room.</t></is></c></row></sheetData></worksheet>'''
strings = '''<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <si><t>Script</t></si></sst>'''
audition_sheet = '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetData>
   <row r="1"><c r="E1" t="inlineStr"><is><t>Before the header.</t></is></c></row>
   <row r="2">
     <c r="C2" t="inlineStr"><is><t>Character Profile (English)</t></is></c>
     <c r="D2" t="inlineStr"><is><t>Emotional Notes (English)</t></is></c>
     <c r="E2" t="inlineStr"><is><t>试音台词（英）</t></is></c>
   </row>
   <row r="3">
     <c r="C3" t="inlineStr"><is><t>Role description: A quiet narrator.</t></is></c>
     <c r="D3" t="inlineStr"><is><t>Narrator: Deliver this with a pause.</t></is></c>
     <c r="E3" t="inlineStr"><is><t>Wait—did you hear that?</t></is></c>
   </row>
   <row r="4">
     <c r="D4" t="inlineStr"><is><t>Sound falls away here.</t></is></c>
     <c r="E4" t="inlineStr"><is><t>There’s a light in the window.</t></is></c>
   </row>
   <row r="5"><c r="E5" t="inlineStr"><is><t>Instructions: Pause after the second line.</t></is></c></row>
 </sheetData></worksheet>'''
files = {"xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": rels,
         "xl/worksheets/sheet1.xml": sheet, "xl/worksheets/sheet2.xml": sheet2, "xl/sharedStrings.xml": strings}
for name, changes in [
    ("dialogue.xlsx", {}),
    ("english-audition-header.xlsx", {"xl/worksheets/sheet1.xml": audition_sheet}),
    ("macro.xlsx", {"xl/vbaProject.bin": "inert dummy payload"}),
    ("external.xlsx", {"xl/_rels/workbook.xml.rels": rels.replace('Target="worksheets/sheet1.xml"',
        'TargetMode="External" Target="https://invalid.example/file.xml"')}),
    ("entities.xlsx", {"xl/workbook.xml": '<!DOCTYPE workbook [<!ENTITY example "example">]>' + workbook}),
    ("expansion.xlsx", {"xl/larger-than-limit.xml": b"x" * (8 * 1024 * 1024 + 1)}),
]:
    with ZipFile(directory / name, "w", compression=8) as archive:
        for entry, data in {**files, **changes}.items():
            archive.writestr(entry, data)

book = xlwt.Workbook()
for name, phrase in [("Legacy dialogue", "Narrator: Stay close to the window."), ("Directions", "Instructions: Read clearly.")]:
    tab = book.add_sheet(name)
    tab.write(0, 0, phrase)
book.save(str(directory / "dialogue.xls"))

document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
 <w:p><w:r><w:t>Recording script</w:t></w:r></w:p>
 <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Narrator: Listen to the rain.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
 <w:p><w:r><w:t>Quietly, we found our way home.</w:t><w:br w:type="page"/><w:t>A new day begins.</w:t></w:r></w:p>
 </w:body></w:document>'''
with ZipFile(directory / "dialogue.docx", "w", compression=8) as archive:
    archive.writestr("word/document.xml", document)

# Tiny two-page selectable-text PDF with an explicit cross-reference table.
def stream(line):
    raw = f"BT /F1 12 Tf 40 700 Td ({line}) Tj ET".encode()
    return b"<< /Length %d >>\nstream\n" % len(raw) + raw + b"\nendstream"

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("Narrator: The rain slows."),
    stream("Narrator: A lantern lights the path."),
]
data = b"%PDF-1.4\n"
offsets = []
for index, item in enumerate(objects, 1):
    offsets.append(len(data))
    data += b"%d 0 obj\n" % index + item + b"\nendobj\n"
xref = len(data)
data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
for offset in offsets:
    data += b"%010d 00000 n \n" % offset
data += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
(directory / "dialogue.pdf").write_bytes(data)
