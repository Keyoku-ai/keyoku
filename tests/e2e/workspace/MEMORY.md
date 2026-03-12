# Project Memory

## Architecture Decisions
- Using React + TypeScript for frontend
- Railway for backend hosting, Vercel for frontend
- PostgreSQL for production, SQLite for development
- Plaid API for bank account integration
- TailwindCSS for styling, shadcn/ui for components

## Current Sprint
- Transaction categorization ML model at 94% accuracy
- CSV import feature has duplicate detection bug (hash comparison issue)
- Dashboard wireframes complete, React components in progress
- Need to implement budget alerts before next demo

## Team Context
- Alex Chen (co-founder): wants MVP demo in 6 weeks, Friday updates
- Sarah (design): sent dashboard mockups, waiting on feedback
- David Park (investor): asked about burn rate at last board meeting
- Weekly standup every Monday at 10am Pacific

## Technical Notes
- Plaid webhook timeouts happening in sandbox — documentation unclear on retry behavior
- Date parsing broken for international formats (DD/MM/YYYY vs MM/DD/YYYY)
- Consider switching to date-fns for date handling instead of moment.js
- Redis caching layer planned for production but not MVP
