# nfl-props-relay

Separate Vercel project (Root Directory = `relay`) that posts NFL props model report cards to Discord.
Kept out of the root `api/` folder so sharp-indicator stays within the Hobby plan's 12-function limit.
Env var: `nflreports` = Discord webhook URL (set in the nfl-props-relay project only).
