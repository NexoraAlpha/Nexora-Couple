# Nexora Couple

Mobile-first couple dashboard with Nexora visual language.

## Stack
- Static HTML/CSS/JS
- Vercel
- Supabase Auth/Database/Realtime (next integration step)
- Leaflet + OpenStreetMap for the map

## Important
This project is separate from Nexora Alpha. Do not reuse the Nexora Alpha Supabase service role key.

1. Create a new Supabase project.
2. Run `SUPABASE_COUPLE_SETUP.sql`.
3. Put the project's URL and anon key into `config.js`.
4. Push this folder to a new GitHub repo.
5. Import the repo into Vercel.

The current UI includes a working browser geolocation preview. Full authenticated pairing + partner realtime reads should be implemented with secure RLS/RPC before production use.
