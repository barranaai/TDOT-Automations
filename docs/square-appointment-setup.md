# Square appointment write-back — setup / readiness

When a consultation is paid, the system creates the appointment on the seller's
real Square Appointments calendar with the client as the customer and a seller
note (`"<In-person|Virtual> consultation — <name> (<case type>)"`), and stores the
`Square Booking ID` on the lead.

Code: `consultationService.createSquareBooking` (best-effort, called from
`onSlotConfirmed`). It **fails closed** — until everything below is in place it
just logs `[Consult] Square booking ... failed` and the booking is unaffected.

## It activates automatically — no code change needed

`createSquareBooking` already runs on every paid booking. The moment Square
enables seller-level writes on the plan, it starts succeeding on its own. Nothing
to deploy at that point — just confirm with the preflight.

## The blocker (pending): Square plan

Creating an appointment on the seller's behalf needs **seller-level writes**,
available on **Square Appointments Plus / Premium**. This is the flag we're
waiting on (`support_seller_level_writes` in the business booking profile).

## Config that must be in place (the groundwork)

Env vars on Render:
- `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` — already used for availability + checkout.
- `SQUARE_CONSULT_SERVICE_VARIATION_ID` — **required for the write-back**; the Appointments *service variation* used for consults. If this isn't set, the write-back is a silent no-op even once the plan allows writes.
- `SQUARE_TM_SHAFOLI` / `SQUARE_TM_SHERMIN` — the consultants' team-member ids (have defaults in `config/consultantRouting.js`).
- `SQUARE_CONSULT_DURATION_MIN` — optional (default 30).

Square-side requirements:
- The consult **service variation** must be **bookable** and have **no cancellation / no-show fee** (the Bookings API refuses to create bookings for variations that do).
- The client needs a **valid phone** — `CreateBooking` 400s without one (we normalize `lead.phone` to E.164; if a lead has no usable phone, that one booking is skipped).

## Check readiness anytime

```
POST https://tdot-automations.onrender.com/api/square-booking-preflight
  header:  X-Api-Key: <ADMIN_API_KEY>
```
- `ready: true` → the write-back is live; new paid bookings create Square appointments.
- `ready: false` → the `checks` object shows exactly what's pending, including
  `sellerLevelWrites` (the plan flag) and whether the service variation is set / found / bookable.
