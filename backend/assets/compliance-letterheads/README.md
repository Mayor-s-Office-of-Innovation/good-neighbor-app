# Compliance letterheads

`dph.docx` and `hsh.docx` are the supplied department letterhead sources:

- SFDPH official letterhead Director Tsai -2.docx
- HSH Letterhead_Color_2026_Accessible.docx

Keep the sources unchanged when regenerating artwork. The generator uses the
first page of each template; HSH's additional blank page with a page number is
not part of the generated one-page letter.

Render each DOCX to PDF and PNG with an Office-compatible renderer, inspect
both first pages against the source, then run from the repository root:

```sh
node backend/scripts/build-compliance-letterheads.mjs \
  /path/to/dph.pdf /path/to/dph/page-1.png \
  /path/to/hsh.pdf /path/to/hsh/page-1.png
```

The generated `backend/src/domain/compliance-letterhead-artwork.js` embeds
vector PDF artwork and a matching 144-dpi PNG for the SVG dashboard preview.
Both are bundled into the Lambda by esbuild, so generation requires no Word,
LibreOffice, external file storage, or template conversion service at runtime.
The original artwork was rendered with the Codex bundled DOCX renderer on
October 27, 2026. Review populated PDFs and previews after replacing artwork.

Selection uses `letterInputs.departmentName`, the sender department captured
when terms are created. DPH/HSH abbreviations and full department names are
supported. Historical records without a recognized department keep the plain
layout. No assignment lookup or new setup validation is involved. Body text and
the sender signature remain selectable PDF text, with space reserved above and
below for the letterhead. Existing stored letters are not regenerated.
