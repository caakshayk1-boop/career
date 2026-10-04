---
name: job-application-engine
description: End-to-end job application engine. Searches live openings on Indeed, scores each one against the user's actual resume, then writes a separately tailored, ATS-safe CV for every single job using Google's XYZ bullet formula, and delivers a tracker spreadsheet covering every application. Use this skill whenever the user mentions job hunting, applying to jobs, finding a new role, switching careers, tailoring or optimizing a resume or CV, beating the ATS, resume keywords, or job applications — including bare requests like "help me find a job", "fix my resume", or an uploaded resume with no instructions. Do NOT use for hiring-side work such as screening candidates or writing job descriptions.
---

# Job Application Engine

Turns one resume into a batch of job-specific applications. For each live opening it finds, it produces a CV rewritten for that job alone — same facts, different emphasis, different keywords — plus a tracker so nothing gets lost.

## What this does and does not do

It does: find real openings, score fit honestly, rewrite the CV per job, package everything with apply links and a tracker.

It does **not** submit applications. The Indeed connector is read-only (`search_jobs`, `get_job_details` only), and automated form submission on job boards breaks their terms of service and trips bot detection. Say this plainly at the start so the user isn't waiting for something that won't come. The user clicks apply; everything up to that click is done for them.

Set that expectation in the first response. Do not bury it at the end.

## Preflight

Check the Indeed connector is available. If `search_jobs` is not in the tool list, search the connector registry and surface Indeed to the user, then stop until it is connected — the skill cannot run without live job data.

Ask for a resume. PDF, .docx, or pasted plain text all work.

If they don't have one — no file, an outdated one they can't locate, or a fresher with nothing — do not stop. Read `references/resume-interview.md` and build the Master Profile by interview instead. Say plainly that this takes about ten minutes and produces a CV from scratch. Roughly a third of the people this skill reaches will land here; treating it as an error state loses them.

## Phase 1 — Intake

Read the resume first, then ask only for what the resume cannot tell you. Asking for someone's job title when it's on line 3 of their CV destroys trust immediately.

Gather, using tappable options where the answers are enumerable:

- **Target roles** — two or three job titles they want. If unsure, propose three based on the resume and let them pick.
- **Location(s)** and **work mode** — city, remote, hybrid, or open.
- **Industry / domain** — the sector they want, which may differ from where they've worked.
- **Target salary** — a number and a currency. Used for filtering and for the fit score, not printed on the CV.
- **Seniority target** — same level, step up, or step down.
- **Dealbreakers** — anything that auto-disqualifies a listing (no relocation, no night shifts, no contract roles, must sponsor a visa).

Keep this to two rounds of questions maximum. Every extra round loses people.

## Phase 2 — Build the Master Profile

This is the most important step and the reason this skill produces CVs that survive interviews.

Extract everything from the resume into a single structured Master Profile: contact details, each role with dates and employer, every responsibility and achievement as a raw claim, education, skills, tools, certifications, languages. Save it to `master_profile.json` in the working directory.

**The Master Profile is the only permitted source of fact for every CV generated afterwards.** Tailoring means selecting, reordering, and rephrasing what is in here. It never means adding. If a job wants Kubernetes and the profile has no Kubernetes, the CV does not get Kubernetes.

While extracting, build a `gaps` list:
- Achievements with no number attached
- Roles with vague responsibilities and no outcome
- Skills mentioned in passing that are never evidenced
- Employment gaps over six months

Show the user the gaps before moving on and ask if they can supply real numbers for the top few. Numbers they give you become part of the Master Profile. Numbers they can't give become `[NEED NUMBER]` placeholders later — never invented.

### What to inherit from their existing CV, and what not to

**Inherit the content and the structure they chose:** section order and which sections exist (some people lead with Skills, freshers lead with Education, that's a real signal about how they see themselves), their preferred professional headline, how they name employers, whether they use a Summary or an Objective, any Projects or Volunteering section they deliberately included. Preserve their voice where it's serviceable — a CV that reads nothing like the person is a problem in the interview.

**Do not inherit their visual formatting.** People's existing CVs are frequently the reason they aren't getting callbacks — two-column Canva templates, photos, skill rating bars, sidebars, tables. Inheriting that inherits the problem. The build script's format is imposed, not negotiated.

Instead, turn this into a moment of value. When reading their CV, note anything that would break a parser and tell them in one short list: what you found, why it breaks, what you changed. "Your CV is two-column — parsers read straight across, so your job titles were landing inside your skills list" is the most useful sentence some of these users will read all week. It also explains why the output looks different from what they uploaded, which otherwise reads as the tool ignoring their design.

Read `references/xyz-bullets.md` now; it governs how every bullet gets written.

## Phase 3 — Search and score

Run `search_jobs` once per target role, and again per location if multiple. Pull `get_job_details` on every promising result — the search snippet is too thin to tailor against. Deduplicate by company plus title.

Score each job 0–100 using `references/fit-scoring.md`. Then apply the honesty rule that makes this skill worth using: **tell the user which jobs not to apply to.** A ranked list where everything scores 80 is a list nobody trusts.

Present the results as a compact table: rank, company, title, location, salary if listed, fit score, and a one-line reason. Group into Strong (75+), Worth a shot (55–74), and Skip (under 55), with the skip reason stated.

Proceed with the top 10–15 by default. Let the user add or remove before generating anything — generating fifteen CVs and then hearing "I'd never work there" wastes everyone's time.

## Phase 4 — Tailor one CV per job

For each selected job, in sequence:

1. **Extract the JD's requirements** — hard skills, tools, certifications, the seniority verbs used ("own", "lead", "support", "assist"), and the three or four things the description repeats. Repetition signals what the hiring manager actually cares about.

2. **Map each requirement to evidence in the Master Profile.** Requirements with no matching evidence go in an unmatched list — that is the honest gap, and it gets reported, not papered over.

3. **Rewrite and reorder.** The summary is rewritten for this role. Bullets under each job are reordered so the most relevant sits first. Bullets are rewritten in XYZ form using the JD's own vocabulary where the underlying fact genuinely matches — if the profile says "handled client escalations" and the JD says "stakeholder management", that is a legitimate rephrasing. If the profile says "handled client escalations" and the JD says "P&L ownership", that is not.

4. **Set keyword coverage honestly.** Aim to naturally carry the JD's core terms into bullets that were already true. Do not append a keyword list, do not white-text keywords, do not repeat a term to inflate density. Recruiters read the CV after the parser does, and stuffing is obvious in four seconds.

5. **Generate the file** by writing a tailoring JSON and running:
   ```
   python3 scripts/build_cv.py --profile master_profile.json --tailor <job>.json --out "outputs/CVs/<Name>_<Company>_<Role>.docx"
   ```
   The script produces the formatting — section rules, right-tabbed dates, weight hierarchy, muted secondary text — while staying parser-safe. Do not hand-build the document and do not add tables, columns, or images to make it look richer; that is exactly what breaks parsing. Read `references/ats-formatting.md` for what it enforces and why.

6. **Record** the fit score, keywords matched, keywords missing, and the count of `[NEED NUMBER]` flags for the tracker.

Keep one CV to one page for under ten years of experience, two pages beyond that.

## Phase 5 — Deliver

Build the tracker:
```
python3 scripts/build_tracker.py --applications applications.json --out outputs/Job_Application_Tracker.xlsx
```

If Google Drive is connected, upload the tracker there — Drive converts .xlsx to a live Google Sheet the user can edit and share. Ask before uploading. If Drive isn't connected, present the .xlsx file directly; do not make the user connect something to get their own output.

Then present all files and close with:
- How many CVs were generated and where they are
- The total count of `[NEED NUMBER]` placeholders across all CVs, and that these must be filled before sending
- The single strongest match and why
- The one skill that appeared in the most job descriptions and is missing from their profile — this is the highest-value thing they could go learn

## Non-negotiable honesty rules

These exist because a fabricated CV gets caught in the interview, and the person who gets hurt is the user.

- **Never invent a metric.** Not a percentage, not a headcount, not a revenue figure, not a timeframe. Where XYZ needs a number the profile lacks, write `[NEED NUMBER: e.g. team size]` and let the user fill it.
- **Never invent a skill, tool, certification, employer, or date.**
- **Never inflate a title.** "Associate Manager" does not become "Manager".
- **Never extend dates** to hide a gap.
- **Never use hidden text, white-on-white keywords, or invisible layers.** Modern parsers extract them and ATS vendors flag them as fraud.
- If a job is a poor match, say so rather than stretching the CV to fit. Ten honest applications beat forty stretched ones.

## Reference files

- `references/xyz-bullets.md` — Google's XYZ formula, worked examples, common failures
- `references/resume-interview.md` — building a Master Profile from scratch when there's no resume
- `references/ats-formatting.md` — what parsers break on and what the CV script enforces
- `references/fit-scoring.md` — the 0–100 scoring rubric

## Scripts

- `scripts/build_cv.py` — Master Profile + tailoring JSON to an ATS-safe .docx
- `scripts/build_tracker.py` — applications JSON to a multi-sheet .xlsx tracker
