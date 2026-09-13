# First scorecard notice

This run's worth-sending gate approved the first-scorecard notification (decision: `send`,
"All required checks, dimension minimums, and the send threshold pass."), but the WhatsApp Sandbox
leg of the text channel did not fire a `text_out` event in this particular run, so there is no
literal WhatsApp message text to show. What the run did produce is the equivalent self-notice email
(`dara@loomwork.example` to herself, subject "[Exhibit] Your first scorecard"), which carries the
same content the phone text is built from:

> Done. I found 18 pieces of evidence you already have. O-1A: 7 of 8 criteria. EB-1A: 7 of 10.
> Closest gap: #6 Scholarly articles is empty: a talk at a major conference counts (comparable
> evidence); submit a talk proposal. 6 figures to review:
> 1. FIG-001 (EX-1-001 #1): acceptance rate: 1 percent of applicants accepted
> 2. FIG-003 (EX-2-001 #2): acceptance rate: 2 percent of nominees admitted
> 3. FIG-004 (EX-3-001 #3): monthly unique visitors: 1,150,000 monthly unique visitors
> 4. FIG-006 (EX-3-003 #3): downloads per episode: 85,000 downloads per episode
> 5. FIG-008 (EX-4-001 #4): submissions: 62 submissions
> 6. FIG-009 (EX-4-002 #4): submissions: 40 submissions
> Reply "approve <numbers>" or "approve all", or "deny <number> <reason>".

See `docs/sample-output/README.md` for how this run was generated.
