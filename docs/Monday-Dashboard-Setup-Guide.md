Monday.com Dashboard & View Setup Guide

Prepared for TDOT Immigration — All Role Dashboards
Roles covered: Case Officer · Case Manager · Case Supervisor · Business Ops Manager · Owner
Estimated setup time: 45–60 minutes


What Has Already Been Done

The following saved views have been created on your boards via API.
They will appear under the Views menu (left panel) on each board.
You only need to add filters to each view — the views themselves already exist.

Document Checklist Execution Board — 4 views created:
    Needs Review
    Rework Requested
    Escalated Items
    Reviewed Today

Questionnaire Execution Board — 4 views created:
    Needs Review
    Needs Clarification
    Escalated Items
    Reviewed Today

Client Master Board — 5 views created:
    Red Cases
    At Risk Cases
    Expiry Alerts
    Client Blocked
    Case Health Overview


PART 1 — Add Filters to Each Saved View

These steps are the same for all views. Open the board, click the view name from the left panel, then click Filter at the top right of the board, and add the conditions listed below for each view.


Note on filter conditions: when you add more than one filter, Monday.com shows an "And" button between them. The default is AND, meaning all conditions must match. Click "And" to toggle it to "Or" if you need either condition to match. For all views below, use AND unless stated otherwise.


Document Checklist Execution Board

View: Needs Review
    Filter 1: Review Required = Yes
    (Optional) AND Filter 2: Assigned Reviewer = Me

View: Rework Requested
    Filter 1: Document Status = Rework Required

View: Escalated Items
    Note: The Escalation Required column on this board uses specific labels — not "Yes".
    Use this filter instead:
    Filter 1: Escalation Required = Triggered by Rework

View: Reviewed Today
    Filter 1: Review Completed Date = Today
    AND Filter 2: Document Status = Reviewed


Questionnaire Execution Board

View: Needs Review
    Filter 1: Review Required = Yes
    AND Filter 2: Response Status = Answered
    (Optional) AND Filter 3: Assigned Reviewer = Me

View: Needs Clarification
    Filter 1: Response Status = Needs Clarification

View: Escalated Items
    Note: The Escalation Required column on this board uses specific labels — not "Yes".
    Use this filter instead:
    Filter 1: Escalation Required = Triggered by Clarification

View: Reviewed Today
    Filter 1: Review Completed Date = Today
    AND Filter 2: Response Status = Reviewed


Client Master Board

View: Red Cases
    Filter 1: Case Health Status = Red

View: At Risk Cases
    Filter 1: SLA Risk Band = Orange
    OR Case Health Status = Orange

View: Expiry Alerts
    Filter 1: Expiry Risk Flag = Flagged

View: Client Blocked
    Filter 1: Client-Blocked Status = Yes

View: Case Health Overview
    No filter — shows all active cases
    Sort by: Case Health Status (Red first)

View: Approaching Deadlines
    Filter 1: Days to Hard Deadline is between 0 and 14
    Sort by: Days to Hard Deadline (ascending)

View: Escalations Open
    Filter 1: Escalation Required = Yes
    Sort by: Case Health Status (Red first)


PART 1B — Create Two Formula Columns on the Client Master Board

Two formula columns are referenced in the dashboard widgets but do not exist yet.
You must create them manually in Monday.com before setting up the widgets.


Formula Column 1 — Days to Hard Deadline

This shows how many calendar days remain before the case Hard Deadline.
Turns negative once the deadline has passed.

Steps:
1. Open the Client Master Board
2. Click the + button at the far right of the column headers to add a new column
3. Choose Formula as the column type
4. Name it: Days to Hard Deadline
5. Enter this formula:
   {Hard Deadline} - TODAY()
   (Monday will automatically convert date subtraction to a number of days)
6. Click Create Column
7. The column will now show a live countdown for every row that has a Hard Deadline set


Formula Column 2 — Overall Case Readiness %

This shows the average of Questionnaire Readiness % and Documents Readiness %
as a single combined readiness score per case.

Steps:
1. On the Client Master Board, click + to add a new column
2. Choose Formula as the column type
3. Name it: Overall Case Readiness %
4. Enter this formula:
   ROUND(({Questionnaire Readiness %} + {Documents Readiness %}) / 2, 0)
5. Click Create Column
6. The column will display 0–100 representing combined case readiness

Note: Both columns use curly-brace references to the exact column names on your board.
If your column names differ slightly (e.g. "Q Readiness %" instead of "Questionnaire Readiness %"),
adjust the formula to match.


PART 2 — Create the Dashboards

Monday.com does not allow dashboard creation via API (internal limitation).
You need to create them manually. Follow these steps.


How to create a dashboard

1. In the left sidebar, click the + button next to Dashboards
2. Choose New Dashboard
3. Give it the name shown below
4. When prompted to connect boards, add the boards listed for each dashboard
5. Click Create Dashboard


Dashboard 1 — Case Officer: Daily Overview

Boards to connect:
    Client Master Board
    Document Checklist Execution Board
    Questionnaire Execution Board


Dashboard 2 — Ops Supervisor: Risk and Escalation

Boards to connect:
    Client Master Board
    Document Checklist Execution Board
    Questionnaire Execution Board
    SLA Configuration Board
    Escalation Routing Matrix Board


Dashboard 3 — Case Manager: Submission Readiness

Boards to connect:
    Client Master Board
    Document Checklist Execution Board
    Questionnaire Execution Board


Dashboard 4 — Case Supervisor: Team Performance & SLA Compliance

Boards to connect:
    Client Master Board
    Document Checklist Execution Board
    Questionnaire Execution Board


Dashboard 5 — Business Ops Manager / Owner: Portfolio Intelligence

Boards to connect:
    Client Master Board


PART 3 — Add Widgets to Each Dashboard

After creating a dashboard, click + Add Widget in the top right to add each widget below.


Dashboard 1 — Case Officer: Daily Overview

Widget 1 — My Document Review Queue
    Widget type: Table
    Board: Document Checklist Execution Board
    Filter: Review Required = Yes, Assigned Reviewer = Me
    Columns to show: Case Reference, Document Name, Document Status, Rework Count, Review Notes, Assigned Reviewer
    Title: My Document Review Queue

Widget 2 — My Questionnaire Review Queue
    Widget type: Table
    Board: Questionnaire Execution Board
    Filter: Review Required = Yes, Assigned Reviewer = Me
    Columns to show: Case Reference, Question Name, Response Status, Clarification Count, Review Notes, Assigned Reviewer
    Title: My Questionnaire Review Queue

Widget 3 — My Cases Health
    Widget type: Table
    Board: Client Master Board
    Filter: Case Manager = Me OR Ops Supervisor = Me
    Columns to show: Case Reference Number, Case Type, Case Stage, Questionnaire Readiness %, Documents Readiness %, Blocking Docs Count, Blocking Questions Count, Days to Hard Deadline, SLA Risk Band, Expiry Risk Flag, Client-Blocked Status, Case Health Status
    Sort by: Case Health Status (Red first)
    Title: My Cases — Health Snapshot

Widget 4 — Items Needing Review (count)
    Widget type: Numbers
    Board: Document Checklist Execution Board
    Filter: Review Required = Yes, Assigned Reviewer = Me
    What to count: Items
    Title: Docs Awaiting Review

Widget 5 — Questionnaire Items Needing Review (count)
    Widget type: Numbers
    Board: Questionnaire Execution Board
    Filter: Review Required = Yes, Assigned Reviewer = Me
    What to count: Items
    Title: Questions Awaiting Review


Dashboard 2 — Ops Supervisor: Risk and Escalation

Widget 1 — Red Cases
    Widget type: Table
    Board: Client Master Board
    Filter: Case Health Status = Red
    Columns to show: Case Reference Number, Client Full Name, Case Type, Case Stage, SLA Risk Band, Escalation Required, Escalation Reason, Expiry Risk Flag, Client-Blocked Status, Days to Hard Deadline, Ops Supervisor
    Title: Red Cases — Requires Immediate Attention

Widget 2 — Expiry Risk Cases
    Widget type: Table
    Board: Client Master Board
    Filter: Expiry Risk Flag = Flagged
    Columns to show: Case Reference Number, Client Full Name, Case Type, Passport Expiry Date, IELTS Expiry Date, Medical Expiry Date, Case Health Status, Case Manager
    Title: Expiry Risk Cases

Widget 3 — Client Blocked Cases
    Widget type: Table
    Board: Client Master Board
    Filter: Client-Blocked Status = Yes
    Columns to show: Case Reference Number, Client Full Name, Case Type, Chasing Stage, Reminder Count, Last Client Activity Date, Assigned Case Manager
    Title: Client Blocked — Action Required

Widget 4 — Escalated Items (Documents)
    Widget type: Table
    Board: Document Checklist Execution Board
    Filter: Escalation Required = Triggered by Rework
    Columns to show: Case Reference, Document Name, Escalation Required, Rework Count, Document Status, Assigned Reviewer
    Title: Escalated Documents

Widget 5 — Escalated Items (Questionnaire)
    Widget type: Table
    Board: Questionnaire Execution Board
    Filter: Escalation Required = Yes
    Columns to show: Case Reference, Question Name, Escalation Required, Response Status, Assigned Reviewer
    Title: Escalated Questionnaire Items

Widget 6 — Risk Summary (counts)
    Widget type: Numbers (add 4 separate number widgets in a row)
    Widget A: Board: Client Master, Filter: Case Health Status = Red, Title: Red Cases
    Widget B: Board: Client Master, Filter: Expiry Risk Flag = Flagged, Title: Expiry Flagged
    Widget C: Board: Client Master, Filter: Client-Blocked Status = Yes, Title: Client Blocked
    Widget D: Board: Client Master, Filter: Escalation Required = Yes, Title: Escalation Required

Widget 7 — SLA Risk Band Breakdown
    Widget type: Chart (Pie or Bar)
    Board: Client Master Board
    Group by: SLA Risk Band
    Title: SLA Risk Band Distribution


Dashboard 3 — Case Manager: Submission Readiness

Widget 1 — Cases in Internal Review
    Widget type: Table
    Board: Client Master Board
    Filter: Case Stage = Internal Review, Case Manager = Me
    Columns to show: Case Reference Number, Case Type, Questionnaire Readiness %, Documents Readiness %, Blocking Docs Count, Blocking Questions Count, Ready for Submission Prep, Days to Hard Deadline
    Title: Cases in Internal Review

Widget 2 — Cases in Submission Preparation
    Widget type: Table
    Board: Client Master Board
    Filter: Case Stage = Submission Preparation, Case Manager = Me
    Columns to show: Case Reference Number, Case Type, Overall Case Readiness %, Automation Lock, Submission Prep Deadline, Days to Hard Deadline
    Title: Cases in Submission Preparation

Widget 3 — Overall Readiness Progress
    Widget type: Chart (Bar chart)
    Board: Client Master Board
    Filter: Case Manager = Me
    Group by: Case Stage
    Value: Documents Readiness % (average)
    Title: Case Readiness — My Portfolio
    Note: The Battery widget does not support formula or percentage columns.
    Use a Bar Chart widget instead — it shows readiness visually per stage.
    Alternatively, add two Numbers widgets side by side:
        Widget A: Board: Client Master, Filter: Case Manager = Me, Column: Documents Readiness %, Aggregation: Average, Title: Avg Doc Readiness
        Widget B: Board: Client Master, Filter: Case Manager = Me, Column: Questionnaire Readiness %, Aggregation: Average, Title: Avg Q Readiness


Dashboard 4 — Case Supervisor: Team Performance & SLA Compliance

Widget 1 — Full Team Case Load
    Widget type: Table
    Board: Client Master Board
    Filter: none (shows all active cases)
    Columns to show: Case Reference Number, Client Full Name, Case Type, Case Stage, Assigned Case Manager, SLA Risk Band, Case Health Status, Days to Hard Deadline, Client-Blocked Status, Escalation Required
    Sort by: Case Health Status (Red first), then Days to Hard Deadline (ascending)
    Title: All Active Cases — Team Overview

Widget 2 — Workload by Case Manager
    Widget type: Chart (Bar chart)
    Board: Client Master Board
    Group by: Assigned Case Manager
    Count: Items
    Title: Caseload Distribution by Case Manager
    Note: Helps the supervisor spot overloaded team members and rebalance cases.

Widget 3 — SLA Compliance Snapshot
    Widget type: Chart (Pie chart)
    Board: Client Master Board
    Group by: SLA Risk Band
    Title: SLA Risk Band Distribution — Whole Team
    Note: Red and Orange slices require immediate supervisor attention.

Widget 4 — Cases Approaching Hard Deadline (14 days)
    Widget type: Table
    Board: Client Master Board
    Filter: Days to Hard Deadline is between 0 and 14
    Columns to show: Case Reference Number, Client Full Name, Case Type, Hard Deadline, Days to Hard Deadline, Assigned Case Manager, SLA Risk Band
    Sort by: Days to Hard Deadline (ascending)
    Title: Deadlines in the Next 14 Days

Widget 5 — Open Escalations Requiring Supervisor Action
    Widget type: Table
    Board: Client Master Board
    Filter: Escalation Required = Yes
    Columns to show: Case Reference Number, Client Full Name, Case Type, Escalation Reason, Case Stage, Case Health Status, Assigned Case Manager, Days to Hard Deadline
    Sort by: Case Health Status (Red first)
    Title: Escalations Awaiting Supervisor Review

Widget 6 — Team Review Queue (Documents)
    Widget type: Numbers
    Board: Document Checklist Execution Board
    Filter: Review Required = Yes
    What to count: Items
    Title: Doc Items Awaiting Team Review
    Note: Add next to Widget 7 in a row.

Widget 7 — Team Review Queue (Questionnaire)
    Widget type: Numbers
    Board: Questionnaire Execution Board
    Filter: Review Required = Yes
    What to count: Items
    Title: Q Items Awaiting Team Review

Widget 8 — Cases Moved to Submission This Month
    Widget type: Numbers
    Board: Client Master Board
    Filter: Case Stage = Submitted, Last Updated = This Month
    What to count: Items
    Title: Submissions This Month


Dashboard 5 — Business Ops Manager / Owner: Portfolio Intelligence

Note: This dashboard is read-only — it gives ownership-level visibility into portfolio health, throughput,
and risk without requiring the user to take action on individual cases.

Widget 1 — Portfolio Health Scorecard (four numbers in a row)
    Widget A — Total Active Cases
        Widget type: Numbers
        Board: Client Master Board
        Filter: none (all items)
        What to count: Items
        Title: Total Active Cases

    Widget B — Red Cases
        Widget type: Numbers
        Board: Client Master Board
        Filter: Case Health Status = Red
        What to count: Items
        Title: Red Cases

    Widget C — Client Blocked
        Widget type: Numbers
        Board: Client Master Board
        Filter: Client-Blocked Status = Yes
        What to count: Items
        Title: Client Blocked

    Widget D — Expiry Flagged
        Widget type: Numbers
        Board: Client Master Board
        Filter: Expiry Risk Flag = Flagged
        What to count: Items
        Title: Expiry Risk

Widget 2 — Portfolio Health Breakdown
    Widget type: Chart (Pie chart)
    Board: Client Master Board
    Group by: Case Health Status
    Title: Portfolio Health — Green / Orange / Red
    Note: The ideal state is a mostly green pie. Red and Orange slices indicate cases at risk.

Widget 3 — Cases by Stage (Pipeline View)
    Widget type: Chart (Bar chart)
    Board: Client Master Board
    Group by: Case Stage
    Count: Items
    Title: Cases by Stage — Full Pipeline
    Note: Shows where the pipeline is concentrated (e.g. Document Collection vs Submission Prep).

Widget 4 — Cases by Case Type
    Widget type: Chart (Pie or Bar chart)
    Board: Client Master Board
    Group by: Case Type
    Count: Items
    Title: Active Cases by Immigration Type

Widget 5 — Top At-Risk Cases (Red + Orange)
    Widget type: Table
    Board: Client Master Board
    Filter: Case Health Status = Red OR SLA Risk Band = Orange
    Columns to show: Case Reference Number, Client Full Name, Case Type, Case Stage, SLA Risk Band, Case Health Status, Expiry Risk Flag, Days to Hard Deadline, Assigned Case Manager, Escalation Required
    Sort by: Case Health Status (Red first)
    Title: Cases Requiring Attention

Widget 6 — Average Readiness Across Portfolio
    Widget type: Numbers (two side by side)
    Widget A: Board: Client Master, Column: Questionnaire Readiness %, Aggregation: Average, Title: Avg Questionnaire Readiness
    Widget B: Board: Client Master, Column: Documents Readiness %, Aggregation: Average, Title: Avg Document Readiness
    Note: These numbers reflect the overall progress of all clients in the system.

Widget 7 — Monthly Submission Throughput
    Widget type: Numbers
    Board: Client Master Board
    Filter: Case Stage = Submitted
    What to count: Items
    Title: Cases Submitted (All Time)
    Note: Monday.com does not natively filter by creation/update month across all plan types.
    If your plan supports timeline or date filtering, add: Last Updated = This Month for a monthly view.
    Otherwise this widget shows cumulative submissions — track month-over-month manually.


PART 4 — Notifications

No manual setup required here. All notification automations listed below are handled automatically by the TDOT automation server (Render). When any of these events occur, the server detects the change via webhook and immediately posts a Monday.com notification to the right person. The notification appears in their Monday.com notification bell and also in their Monday.com notification email.

The following are handled automatically:

    When Document Status changes to Received → Assigned Reviewer is notified
    When Document Status changes to Rework Required → Case Manager is notified
    When Response Status changes to Answered → Assigned Reviewer is notified
    When Response Status changes to Needs Clarification → Assigned Reviewer is notified
    When Case Health Status changes to Red → Ops Supervisor is notified
    When Expiry Risk Flag changes to Flagged → Case Manager and Ops Supervisor are notified
    When Client-Blocked Status changes to Yes → Ops Supervisor and Case Manager are notified
    When Escalation Required changes to Yes (Client Master) → Ops Supervisor is notified


PART 5 — Pin the Most Important Views

To make navigation faster, pin the most-used views so they appear at the top of the left panel on each board.

On Document Checklist Execution Board:
    Right-click Needs Review → Pin to top

On Questionnaire Execution Board:
    Right-click Needs Review → Pin to top

On Client Master Board:
    Right-click Case Health Overview → Pin to top
    Right-click Approaching Deadlines → Pin to top (for Case Supervisors)
    Right-click Escalations Open → Pin to top (for Ops Supervisors)


Once complete, each role will have:

    Case Officer        — opens their dashboard, sees their personal review queues and case health at a glance,
                          clicks a board view to take action on the next item

    Case Manager        — tracks submission readiness across their case portfolio, identifies cases stuck in
                          Internal Review or Submission Prep, monitors readiness progress

    Ops Supervisor      — immediate visibility into all Red cases, escalations, expiry alerts, and
                          client-blocked situations; the escalation engine notifies them automatically

    Case Supervisor     — full team workload view, SLA compliance snapshot, upcoming deadline list,
                          open escalations, and throughput metrics for the whole team

    Business Ops Manager / Owner — executive portfolio health scorecard, pipeline stage distribution,
                          caseload by immigration type, average readiness, and top at-risk cases


ADMIN CONTROL PANEL

In addition to the Monday.com dashboards, the TDOT automation server includes a built-in
Admin Control Panel accessible at:

    https://your-server-url.onrender.com/admin

The Admin Panel allows authorised staff to:
    - Trigger any of the 6 automation engines immediately (without waiting for the 07:00 daily run)
    - Run the full daily sequence in order with a single click
    - Test the Monday.com API connection and confirm the authenticated account
    - Resend intake questionnaire emails for specific cases
    - View a live activity log of all manual triggers

Access requires the ADMIN_API_KEY configured on the server. Enter the key at the login screen.
The key is never stored beyond the current browser session.


Document version 2.0 — April 2026
