# amplitud-clinics-frontend-tester

Integration QA harness for the clinic onboarding contract pack (**Phase 0–G**). The app is a client-only Next.js SPA that exercises clinic Supabase, agnentic, and optional WhatsApp service HTTP from the browser — for engineers validating [`clinics-frontend-docs`](https://github.com/Amplitud-AI/amplitud-docs/tree/main/clinics-frontend-docs) before features land in production UI.

## Quick start

```powershell
git clone https://github.com/Amplitud-AI/amplitud-clinics-frontend-tester.git
cd amplitud-clinics-frontend-tester
Copy-Item env.example .env
# Edit .env — NEXT_PUBLIC_SUPABASE_* and agnentic base URL
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Run prefix **0 → A → B** before parallel lanes.

## Documentation

**Harness behavior (panels, env, quirks):** [clinic-onboarding-flow-tester-docs](https://github.com/Amplitud-AI/amplitud-docs/tree/main/clinic-onboarding-flow-tester-docs) in `amplitud-docs`.

| Question | Read |
| --- | --- |
| HTTP URLs, headers, JSON shapes | [`clinics-frontend-docs`](https://github.com/Amplitud-AI/amplitud-docs/tree/main/clinics-frontend-docs) |
| Production clinic staff UI | [`clinics-control-front`](https://github.com/Amplitud-AI/clinics-control-front) |

Do not treat this README as wire SSOT — use the docs pack and clinics-frontend-docs.
