# Local attachment review

Install the pinned dependencies from `requirements-attachments.txt` in a
Python 3 virtual environment on macOS or Linux. Set `ATTACHMENT_PYTHON` to
the environment's Python executable when it is outside your PATH. For
fixture tests, use `test/requirements-attachments.txt`.

The production review configuration keeps the environment and evidence under
`.voice-otto-local/`, which is excluded from Git and audio-output cleanup.
Build the interpreter with `python3 -m venv .voice-otto-local/python` and
install the production pins with
`.voice-otto-local/python/bin/python -m pip install -r requirements-attachments.txt`.
Point `ATTACHMENT_PYTHON` to that interpreter. The separately authorized
`node connectivity-check.js` command validates the private paths, pinned
dependencies, and journal before making any service checks. It requires dry
run and disabled paid generation and submission.

Run `node attachment-review.js /path/to/local/file.xlsx` to print a local
JSON report. The command does not open Voice123 or write records. Reports
keep cell coordinates, document paragraphs and table cells, or PDF page
numbers, plus candidate labels and review flags. Every result is
`Needs Review`. The reviewer selects the exact script and resolves
attachment, revision, and voice-rights questions explicitly.

For a future project approval, keep the original files under
`VOICE_OTTO_ATTACHMENT_DIR/<VOICE123_PROJECT_ID>/<filename>`. The review
JSON uses an `attachmentReview` object with `outcome: "reviewed"`, a
`reason` describing the selected lines, and a `sources` array containing the
report's provenance objects. The manifest supports up to four files. It
records names, types, sizes, file hashes, extraction hashes and the
extractor version. These fields and the hash of the human-selected script
are bound to the existing approval chain. The application rechecks local
sources before recording approval and before generation or submission.
Local files must remain available and unchanged.

Supported formats are XLSX, Excel compound-document XLS, DOCX, selectable-text
PDF, and UTF-8 TXT. Binary DOC, encrypted files and unsupported encodings are
rejected. There is no OCR, macro execution, formula evaluation, link fetching,
or Word pagination engine. Legacy XLS cell values may reflect saved formula
results. Language and speaker labels are heuristics for review.
Files are bounded to 8 MiB, with additional worker time, output, archive,
page, cell and text limits. The extractor does not use a shell.
