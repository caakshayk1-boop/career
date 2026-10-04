# ATS Formatting: what actually matters

## Correcting the common myth

Applicant Tracking Systems do not "reject" resumes. Greenhouse, Lever, Workday, iCIMS, Taleo and SmartRecruiters parse a document into structured fields and then let a human search and filter. There is no scoring robot deciding your fate.

What actually kills applications:

1. **Parse failure** — the system reads the document badly, so the person's job titles, dates, or employer names land in the wrong fields or vanish. They then don't appear in any recruiter search.
2. **Keyword absence** — recruiters filter by searching terms from the JD. If the CV doesn't contain them, the CV isn't in the result set.
3. **A human deciding in six seconds** — which happens after parsing, and which keyword stuffing actively hurts.

So the goal is: parse cleanly, carry the right true keywords, and read well to a person. Nothing more exotic than that.

## What breaks parsers

- **Multi-column layouts.** The single biggest cause of scrambled output. Text is read left-to-right across the whole page width, so a two-column CV interleaves the sidebar into the job history.
- **Tables.** Some parsers read them cell-by-cell in the wrong order, some drop them.
- **Text boxes and shapes.** Frequently invisible to the extractor.
- **Headers and footers.** Often skipped entirely — never put contact details there.
- **Images, logos, icons, photos, skill-rating bars.** Carry zero extractable text.
- **Non-standard section names.** "Where I've Made an Impact" doesn't map to a field. "Experience" does.
- **Uncommon fonts.** Can produce garbled character extraction.
- **Special bullet characters.** Stick to a standard round bullet.
- **Date formats that vary within one document.** Pick one and hold it.

## What the build script enforces

`scripts/build_cv.py` produces documents that follow these rules, so they don't need to be re-derived per job:

- Single column, full width, no tables, no text boxes, no images
- Contact block in the document body, never the header
- Standard section headings: Summary, Experience, Education, Skills, Certifications, Projects
- Calibri, 10.5pt body, 11pt headings, 16pt name
- Consistent `MMM YYYY – MMM YYYY` date format, with `Present` for current roles
- Standard round bullets, no custom glyphs
- 0.6" margins, no columns, no footers

## File format

Generate **.docx**. It parses more reliably than PDF across older systems, and it stays editable so the user can fill `[NEED NUMBER]` placeholders. If a specific application demands PDF, tell the user to export from Word rather than converting through a tool that may flatten the text.

Never name files "resume.docx". Use `Firstname_Lastname_Company_Role.docx` — recruiters download dozens into one folder.

## Keyword strategy

Carry the JD's exact terminology into bullets that were already true, including the exact form used. If the JD says "stakeholder management", write "stakeholder management" rather than "managing stakeholders" — literal search matching is still common.

Include both the spelled-out term and the acronym on first use where natural: "Search Engine Optimization (SEO)". A recruiter may search either.

Do not: append a keyword block at the end, repeat a term more than its natural frequency, use white or 1pt text, or embed keywords in invisible layers. Parsers extract hidden text and several ATS vendors flag it. It is the fastest way to get blacklisted from a company's system entirely.

## Formatting that is safe and still looks designed

ATS-safe does not mean unformatted. A CV with no hierarchy is harder for the human reader, and the human reader is the one who decides. These all parse cleanly:

- **Paragraph bottom borders** under section headings. A horizontal rule is a border property, not an object — extractors ignore it entirely.
- **Right tab stops** for dates. This is the important one. Most people right-align dates using a two-cell table, which is a parse risk. A right tab stop at the content width produces the identical look with zero risk.
- **Weight, size and colour hierarchy.** Bold job titles, regular company names, muted grey for locations and dates, a larger name at the top. All of it is run-level styling that extracts as plain text.
- **Letter-spacing on section headings.** Purely visual; the extracted string is unchanged.
- **Tight, deliberate vertical rhythm.** Controlled paragraph spacing does more for readability than any graphic element.

What stays banned: columns, tables, text boxes, images, icons, skill-rating bars, headers and footers. The rule of thumb is that anything which is an *object* in the document is a risk, and anything which is a *property of text or a paragraph* is safe.
