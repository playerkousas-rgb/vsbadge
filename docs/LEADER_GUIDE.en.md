# 👨‍💼 Leader guide (Venture Scout Leader / Group Scout Leader / Admin)

> You have full rights: approvals, authorisation, bulk operations.

Tap **中 / EN** (top right) to switch the whole app. Cloud records use the same item IDs; only the display language changes. The English syllabus follows the Scout Association of Hong Kong 11th Edition Venture Scout Training Scheme.

## Core functions

### 1. My progress — any member
- Top “View member” dropdown
- Tick + date (today is filled; you may change it)
- Cascading: ticking a parent ticks children
- Offline draft → Save bar → confirm bulk write to the cloud

### 2. Unit overview — glance + bulk tick
- **Cards**: % complete + four badges; Membership Badge ✓
- **Matrix**: filter by Achievement Badge; max 30 columns; click ✓ to toggle
- **🚀 Camp bulk complete**: date → members (search, select all) → items → mark → draft → confirm save
- **By member / by item**: sub-tabs

### 3. Approvals — member claims
- Date and evidence
- Approve / reject one or many
- Approved items join the save queue

### 4. Print forms — official layout
- Name, YMIS, Group, Achievement Badge dates, other badges
- PT/19 Venture Scout Award, PT/20 Dragon Scout Award
- Edit then print double-sided

### 4b. 📅 Activity log (v8.1)
- **🤝 Service** (role, hours), **🏕️ Activities**, **🎓 Courses** (certificate no.)
- Switch member; members are read-only for themselves
- **➕ Add** / **📥 bulk** (same activity for many members, max 200)
- Edit / delete (delete is confirmed and audited)
- Same tick-permission as progress
- **📅 Log claims** (v8.4): members can self-submit records (“Claim a record”) or edit claims for approved records. Review them under Approvals → “📅 Log claims”:
  - Approving a **new claim** writes it to the activity log (recorder shows “Name (self-reported)”)
  - Approving an **edit claim** updates the same record (the card shows the current record for comparison)
  - Only the activity log has this claim-edit-re-approve loop; badge-progress claims and other badges stay leader-only after approval
- If you see “backend not yet v8.1”, follow DEPLOY_GUIDE v8.1 upgrade; log claims additionally need the v8.4 upgrade (adds the pending-log sheet)

### 5. Users — front-end admin
- Create one account (Leaders do not need YMIS and sign in by email; members/execs require a 10-digit YMIS)
- **🔒 Single Group Leader Lock**: only one active Group Leader per troop. Adding or promoting another GSL is blocked while an active GSL exists. Demote or deactivate the current GSL first to change leadership.
- **📥 Bulk onboard**:
  - **Recommended:** YMIS custom-report PDF (columns: Scout ID → Name in Chinese → Email) → unlock / preview / edit in the browser → confirm. The PDF never leaves the device. See [YMIS_EXPORT.md](YMIS_EXPORT.md)
  - **Fallback:** CSV → preview → write; leader YMIS can be left blank; blank passwords generated. JSON paste also works.
- Accounts and roster-only members are shown together. A roster-only member can be edited, given a sign-in account, or removed from the roster.
- **Unique YMIS / email:** the same YMIS or email (case-insensitive) cannot open another account. Deactivated/deleted account identifiers stay reserved to prevent identity reuse.
- For a member with an account, use **🔑 Change / reset password** to issue a temporary password. Existing sessions are revoked and the member must change it at next sign-in.
- Edit, deactivate / reactivate or delete, and view the audit log. Deleting keeps historical progress/activity records.
- First sign-in after create/reset forces a password change
- Promote member → exec + allow ticking
- **⚙️ Rights**: leaders default `*`; members none; execs default Membership Badge + Activity Achievement Badge + OTHER. Higher roles may limit lower ones.

### 6. Settings — privacy
- **Allow members to view one another’s progress**: off by default; GSL may turn it on

### 7. Account applications
- GSL / VSL → **✅ Approvals** → **👤 Accounts**
- Leaders apply without YMIS using email; approved leaders sign in by email + temporary password.
- Applied role and Group (filled in automatically) are shown
- Approve opens the account in that role; if your level cannot set it, it opens as Member and the GSL can adjust under Users
- A one-time temporary password is shown; the user must change it at first sign-in

### 8. Library
- 11th Edition mapping, training plan, Safe from Harm, wearing guide, form downloads

---
COPYRIGHT 2026 Scout System
