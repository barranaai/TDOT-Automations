Monday.com Dashboard & View Setup Guide

Prepared for TDOT Immigration — Case Officer and Ops Supervisor Dashboards
Estimated setup time: 30–40 minutes


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
    OR Filter 2: Escalation Required = Triggered by SLA
    (Set the condition between them to OR)

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
    OR Filter 2: Escalation Required = Triggered by SLA
    (Set the condition between them to OR)

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
    Filter: Case Manager = Me OR Case Support Officer = Me
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
    Filter: Escalation Required = Yes
    Columns to show: Case Reference, Document Name, Escalation Required, Escalation Reason, Document Status, Assigned Reviewer
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


Once complete, each role will have:

    Case Officer — opens their dashboard, sees their review queues and case health at a glance, clicks a board view to take action
    Ops Supervisor — opens their dashboard, sees all red cases, escalations, and expiry risks immediately
    Case Manager — opens their dashboard, tracks submission readiness across their portfolio


Document version 1.0 — March 2026
