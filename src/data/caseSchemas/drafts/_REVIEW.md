# Draft schema review queue

Generated 68 drafts. Review each against its source PDF, then move to
`src/data/caseSchemas/` and add a `register()` line in `caseSchemaService.js`.

| ⚠ | Case Type | Sub Type | Docs | Roles (role:count) | Note | File |
|---|---|---|---|---|---|---|
|  | Canadian Experience Class (Profile Recreation+ITA+Submission) | CEC Single Applicant | 22 | PrincipalApplicant:12 NonAccompanyingSpouse:6 DependentChild:4 |  | canadian-experience-class-profile-recreation-ita-submission__cec-single-applicant.js |
|  | Canadian Experience Class (Profile Recreation+ITA+Submission) | CEC Accompanying Spouse & Child | 16 | PrincipalApplicant:11 DependentChild:5 |  | canadian-experience-class-profile-recreation-ita-submission__cec-accompanying-spouse-child.js |
|  | Canadian Experience Class (Profile+ITA+Submission) | CEC Single Applicant | 22 | PrincipalApplicant:12 NonAccompanyingSpouse:6 DependentChild:4 |  | canadian-experience-class-profile-ita-submission__cec-single-applicant.js |
|  | Canadian Experience Class (Profile+ITA+Submission) | CEC Accompanying Spouse & Child | 16 | PrincipalApplicant:11 DependentChild:5 |  | canadian-experience-class-profile-ita-submission__cec-accompanying-spouse-child.js |
|  | Canadian Experience Class (EE after ITA) | CEC Single Applicant | 22 | PrincipalApplicant:12 NonAccompanyingSpouse:6 DependentChild:4 |  | canadian-experience-class-ee-after-ita__cec-single-applicant.js |
|  | Canadian Experience Class (EE after ITA) | CEC Accompanying Spouse & Child | 16 | PrincipalApplicant:11 DependentChild:5 |  | canadian-experience-class-ee-after-ita__cec-accompanying-spouse-child.js |
| ⚠ | Citizenship | (none) | 11 | Spouse:7 DependentChild:4 | NO REQUIRED ROLE — check PA section | citizenship__default.js |
|  | Federal PR | Non Express Entry - Accompanying Spouse & Child | 19 | PrincipalApplicant:14 DependentChild:5 |  | federal-pr__non-express-entry-accompanying-spouse-child.js |
|  | Federal PR | Non Express Entry - Non Accompanying Spouse | 20 | PrincipalApplicant:14 NonAccompanyingSpouse:6 |  | federal-pr__non-express-entry-non-accompanying-spouse.js |
| ⚠ | PR Card Renewal | (none) | 10 | Spouse:7 DependentChild:3 | NO REQUIRED ROLE — check PA section | pr-card-renewal__default.js |
| ⚠ | PRTD | (none) | 10 | Spouse:7 DependentChild:3 | NO REQUIRED ROLE — check PA section | prtd__default.js |
| ⚠ | Renunciation of PR | (none) | 9 | Spouse:5 DependentChild:4 | NO REQUIRED ROLE — check PA section | renunciation-of-pr__default.js |
|  | Parents/Grandparents Sponsorship | (none) | 14 | Spouse:9 Sponsor:5 |  | parents-grandparents-sponsorship__default.js |
|  | AAIP | Express Entry Stream | 30 | PrincipalApplicant:13 Spouse:13 DependentChild:4 |  | aaip__express-entry-stream.js |
|  | AAIP | Opportunity Stream | 15 | PrincipalApplicant:12 NonAccompanyingSpouse:3 |  | aaip__opportunity-stream.js |
|  | AAIP | Tourism & Hospitality Stream | 17 | PrincipalApplicant:14 NonAccompanyingSpouse:3 |  | aaip__tourism-hospitality-stream.js |
|  | AAIP | Rural Renewal Stream | 34 | PrincipalApplicant:15 Spouse:15 DependentChild:4 |  | aaip__rural-renewal-stream.js |
|  | BCPNP | BC PNP+ Company Info | 17 | PrincipalApplicant:13 Spouse:4 |  | bcpnp__bc-pnp-company-info.js |
|  | NSNP | (none) | 19 | PrincipalApplicant:15 Spouse:4 |  | nsnp__default.js |
|  | OINP | Foreign Worker Stream | 19 | PrincipalApplicant:16 NonAccompanyingSpouse:3 |  | oinp__foreign-worker-stream.js |
|  | OINP | Human Capital Priorities Stream | 22 | PrincipalApplicant:16 Spouse:6 |  | oinp__human-capital-priorities-stream.js |
|  | OINP | In-demand Skills Stream | 19 | PrincipalApplicant:16 NonAccompanyingSpouse:3 |  | oinp__in-demand-skills-stream.js |
|  | OINP | International Student Stream | 18 | PrincipalApplicant:15 NonAccompanyingSpouse:3 |  | oinp__international-student-stream.js |
|  | OINP | Masters Graduate Stream | 16 | PrincipalApplicant:13 NonAccompanyingSpouse:3 |  | oinp__masters-graduate-stream.js |
|  | OINP | PhD Graduate Stream | 16 | PrincipalApplicant:13 NonAccompanyingSpouse:3 |  | oinp__phd-graduate-stream.js |
|  | OINP | Skilled Trades Stream | 18 | PrincipalApplicant:15 NonAccompanyingSpouse:3 |  | oinp__skilled-trades-stream.js |
|  | Inland Spousal Sponsorship | Marriage | 13 | PrincipalApplicant:8 Sponsor:5 |  | inland-spousal-sponsorship__marriage.js |
|  | Inland Spousal Sponsorship | Common Law Partner | 13 | PrincipalApplicant:8 Sponsor:5 |  | inland-spousal-sponsorship__common-law-partner.js |
|  | Outland Spousal Sponsorship | Marriage | 13 | PrincipalApplicant:8 Sponsor:5 |  | outland-spousal-sponsorship__marriage.js |
| ⚠ | Study Permit | (none) | 17 | PrincipalApplicant:17 | flat fallback | study-permit__default.js |
| ⚠ | Study Permit | Non SDS Stream - Single Applicant | 14 | PrincipalApplicant:14 | flat fallback | study-permit__non-sds-stream-single-applicant.js |
| ⚠ | Study Permit | Non SDS Stream - Accompanying Spouse/Child | 14 | Spouse:10 DependentChild:4 | NO REQUIRED ROLE — check PA section | study-permit__non-sds-stream-accompanying-spouse-child.js |
| ⚠ | Study Permit | SDS Stream - Accompanying Spouse/Child | 14 | Spouse:10 DependentChild:4 | NO REQUIRED ROLE — check PA section | study-permit__sds-stream-accompanying-spouse-child.js |
| ⚠ | Study Permit | Dependent Child - Outland | 4 | Parent:4 | NO REQUIRED ROLE — check PA section | study-permit__dependent-child-outland.js |
| ⚠ | Study Permit | Change of Status (Visitor to Student) | 16 | PrincipalApplicant:16 | flat fallback | study-permit__change-of-status-visitor-to-student.js |
| ⚠ | Study Permit Extension | Single Applicant | 6 | PrincipalApplicant:6 | flat fallback | study-permit-extension__single-applicant.js |
| ⚠ | Study Permit Extension | Accompanying Spouse/Child | 11 | Spouse:7 DependentChild:4 | NO REQUIRED ROLE — check PA section | study-permit-extension__accompanying-spouse-child.js |
|  | Supervisa | Parents | 27 | PrincipalApplicant:10 Spouse:10 Sponsor:7 |  | supervisa__parents.js |
|  | Supervisa | Grandparents | 29 | PrincipalApplicant:11 Spouse:11 Sponsor:7 |  | supervisa__grandparents.js |
|  | TRV | (none) | 3 | PrincipalApplicant:3 |  | trv__default.js |
|  | Visitor Record / Extension | Visitor Record + Restoration | 15 | PrincipalApplicant:8 Sponsor:7 |  | visitor-record-extension__visitor-record-restoration.js |
|  | Visitor Record / Extension | Visitor Record | 15 | PrincipalApplicant:8 Sponsor:7 |  | visitor-record-extension__visitor-record.js |
|  | Visitor Record / Extension | Visitor Extension | 15 | PrincipalApplicant:8 Sponsor:7 |  | visitor-record-extension__visitor-extension.js |
|  | Visitor Visa | Both Parents | 14 | PrincipalApplicant:7 Sponsor:7 |  | visitor-visa__both-parents.js |
|  | Visitor Visa | Single Parent | 14 | PrincipalApplicant:7 Sponsor:7 |  | visitor-visa__single-parent.js |
|  | Visitor Visa | 1-3 Members | 26 | PrincipalApplicant:7 Spouse:7 Sponsor:7 DependentChild:5 |  | visitor-visa__1-3-members.js |
|  | Visitor Visa | 1-2 Members | 21 | PrincipalApplicant:7 Spouse:7 Sponsor:7 |  | visitor-visa__1-2-members.js |
|  | Visitor Visa | Parents & Siblings | 22 | PrincipalApplicant:7 Sponsor:7 Sibling:8 |  | visitor-visa__parents-siblings.js |
|  | Visitor Visa | Spouse | 14 | PrincipalApplicant:7 Sponsor:7 |  | visitor-visa__spouse.js |
|  | Visitor Visa | Spousal Sponsorship in Process | 14 | PrincipalApplicant:7 Sponsor:7 |  | visitor-visa__spousal-sponsorship-in-process.js |
|  | Visitor Visa | Change of Status (Student/Worker to Visitor) | 8 | PrincipalApplicant:8 |  | visitor-visa__change-of-status-student-worker-to-visitor.js |
|  | BOWP | (none) | 10 | PrincipalApplicant:7 DependentChild:3 |  | bowp__default.js |
|  | Concurrent WP | (none) | 11 | PrincipalApplicant:11 |  | concurrent-wp__default.js |
|  | LMIA Exempt WP | (none) | 21 | PrincipalApplicant:16 DependentChild:5 |  | lmia-exempt-wp__default.js |
|  | LMIA Based WP | Inside Canada | 15 | PrincipalApplicant:11 DependentChild:4 |  | lmia-based-wp__inside-canada.js |
|  | LMIA Based WP | Outside Canada | 21 | PrincipalApplicant:16 DependentChild:5 |  | lmia-based-wp__outside-canada.js |
| ⚠ | LMIA Based WP | Extension (Inside Canada) | 4 | DependentChild:4 | NO REQUIRED ROLE — check PA section | lmia-based-wp__extension-inside-canada.js |
| ⚠ | SCLPC WP | (none) | 3 | Parent:3 | NO REQUIRED ROLE — check PA section | sclpc-wp__default.js |
|  | PGWP | (none) | 7 | PrincipalApplicant:7 |  | pgwp__default.js |
|  | PGWP | Extension - Single Applicant | 8 | PrincipalApplicant:8 |  | pgwp__extension-single-applicant.js |
|  | PGWP | Extension - Accompanying Spouse/Child | 15 | PrincipalApplicant:11 DependentChild:4 |  | pgwp__extension-accompanying-spouse-child.js |
|  | PGWP | Inside Canada - Accompanying Spouse/Child | 14 | PrincipalApplicant:10 DependentChild:4 |  | pgwp__inside-canada-accompanying-spouse-child.js |
| ⚠ | SOWP | Spousal Sponsorship in Process | 4 | Spouse:4 | NO REQUIRED ROLE — check PA section | sowp__spousal-sponsorship-in-process.js |
| ⚠ | SOWP | Inland - Established Relationship | 5 | Spouse:5 | NO REQUIRED ROLE — check PA section | sowp__inland-established-relationship.js |
| ⚠ | SOWP | Inland - Non Established Relationship | 5 | Spouse:5 | NO REQUIRED ROLE — check PA section | sowp__inland-non-established-relationship.js |
| ⚠ | SOWP | Outland (Spouse or Child) | 9 | Spouse:5 DependentChild:4 | NO REQUIRED ROLE — check PA section | sowp__outland-spouse-or-child.js |
| ⚠ | SOWP | Extension (Spouse or Child) | 13 | Spouse:9 DependentChild:4 | NO REQUIRED ROLE — check PA section | sowp__extension-spouse-or-child.js |
|  | NB WP Extension | (none) | 6 | PrincipalApplicant:6 |  | nb-wp-extension__default.js |

⚠ = needs extra attention: flat fallback (no applicant sections found), zero docs, or no required role (an empty composition would seed nothing — usually the PA section heading wasn’t recognised).
