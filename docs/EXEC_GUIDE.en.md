# 🎖️ Executive Committee guide

> You have some leader rights on top of member functions.

- All member functions
- **May tick progress** (if authorised). Default: Membership Badge + Activity Achievement Badge (no need to tick every sub-item) + other badges one by one
- May view another member in My progress
- May bulk-tick in Unit overview (if authorised)
- May approve claims (if authorised)

## How to tick for a member
1. My progress → pick the member
2. Tick the item and adjust the date if needed
3. Confirm save at the bottom (drafts stay in the browser until then)

Language: **中 / EN** (top right) switches the whole UI. Backend records use the same item IDs.

## Entering from the main platform (Portal) — no sign-in

If your Group is connected to a main platform (e.g. 82venture), opening the
"Venture Scout Progress" card there signs you in automatically — no vsbadge password.
A blue `Portal` badge appears at the top right.

- The main platform passes your role (e.g. exec committee); rights are the same as a normal sign-in
- You do not need a `ymis`: it falls back to `PORTAL-<group>-<role>` automatically
- **Always open it from the main platform card/link.** Since v3.1 vsbadge verifies the source
  origin, so pasting the URL straight into a browser — or arriving from any other site — is refused
  with a reason on screen. This is what stops anyone from hand-crafting `?role=super_admin`
  to gain admin rights.

Common refusal codes:

| Code | Meaning | What to do |
|---|---|---|
| `referer_mismatch` | Not opened from the registered main-platform URL | Go back to the main platform and open the card again |
| `role_not_allowed` | This Group does not accept your role from the main platform | Ask the GSL/admin to add the role to `portalRoles` |
| `troop_not_portal_enabled` | This Group is not connected to a main platform | Ask an admin to register the main-platform URL |
| `no_origin` | Source could not be confirmed (e.g. opened with curl) | Open it from the main platform card |

Standalone use (path A: open vsbadge.vercel.app → pick your Group → sign in) is unaffected.

---
COPYRIGHT 2026 Scout System
