# Data file schemas

Three JSON files drive the skill. Write them to the working directory as you go.

## master_profile.json — the single source of truth

Every fact on every CV must trace back to this file. Nothing is added later.

```json
{
  "contact": {
    "name": "", "email": "", "phone": "", "location": "",
    "linkedin": "", "portfolio": ""
  },
  "summary": "neutral, untailored version",
  "experience": [
    {"title": "", "company": "", "location": "",
     "start": "Jun 2023", "end": null,
     "bullets": ["raw claims exactly as the resume states them"]}
  ],
  "education": [
    {"degree": "", "institution": "", "year": "", "detail": ""}
  ],
  "skills": {"commercial": [], "technical": [], "tools": []},
  "certifications": [],
  "projects": [{"name": "", "detail": ""}],
  "languages": [],
  "gaps": ["bullets missing metrics, unevidenced skills, employment gaps"]
}
```

`end: null` renders as "Present". Group skills under whatever category labels suit the person — the keys become the printed labels.

## <company>_<role>.json — one per job

Only the keys present here override the Master Profile. Omit a key to inherit it.

```json
{
  "job": {"company": "", "title": "", "location": "", "url": "", "salary": ""},
  "summary": "rewritten for this job",
  "experience": [
    {"title": "", "company": "", "location": "", "start": "", "end": null,
     "bullets": ["XYZ-rewritten, reordered most-relevant-first"]}
  ],
  "skills": {"commercial": ["reordered to lead with what this JD asks for"]}
}
```

## applications.json — feeds the tracker

```json
{
  "candidate": "",
  "generated": "YYYY-MM-DD",
  "applications": [
    {"rank": 1, "company": "", "title": "", "location": "", "salary": "",
     "url": "", "fit_score": 84, "band": "Strong",
     "reason": "one specific line",
     "cv_file": "Name_Company_Role.docx",
     "keywords_matched": [], "keywords_missing": [],
     "need_number_flags": 1, "status": "Not applied",
     "date_applied": "", "follow_up_date": "", "notes": ""}
  ],
  "skipped": [
    {"company": "", "title": "", "location": "", "fit_score": 24,
     "reason": "", "url": ""}
  ],
  "insights": {
    "top_missing_skill": "Power BI (appeared in 9 of 14 JDs)",
    "best_match": "Acme Retail — Operations Manager (84)"
  }
}
```

`band` must be one of `Strong`, `Worth a shot`, `Skip` — the tracker colour-codes on these exact strings. Set `follow_up_date` to roughly seven days after the intended apply date; the follow-up is the step most people skip.
