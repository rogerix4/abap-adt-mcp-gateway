# ABAP side: the bridge modules

These are the only ABAP objects this server needs in a system. Everything else it does
goes through ADT; screens, the CUA, the text pool and Smart Forms have no ADT resource, so
they go through remote-enabled function modules, and those modules live here.

Without them, the bridged route tools and the text-element tools have nothing to call
on a fresh system — they answer with the module-not-found error of the RFC dispatcher.

| File | Function group | What it does | Tools it serves |
|---|---|---|---|
| `ZMCP_ADT_DISPATCH.abap` | `ZMCP_ADT_UTILS` | Screen (dynpro) read / insert / delete and CUA read / write, dispatched by action | `GetScreen` `ReadScreen` `CreateScreen` `UpdateScreen` `DeleteScreen` `GetScreensList` `GetGuiStatus` `ReadGuiStatus` `CreateGuiStatus` `PatchGuiStatus` `DeleteGuiStatus` `UpdateGuiStatus` (+ their `Low` forms) |
| `ZMCP_ADT_TEXTPOOL.abap` | `ZMCP_ADT_UTILS` | Text pool `READ` / `WRITE` | `GetTextElement` `ReadTextElementsBulk` `WriteTextElementsBulk` `CreateTextElement` `UpdateTextElement` `DeleteTextElement` |
| `ZMCP_SSF_CONTENT.abap` | `ZMCP_SSF_UTILS` | SmartForm read: Form Builder XML (`FB_CONVERT_FORM_TO_XML`), style CSS (`SSF_CONVERT_STYLE_TO_CSS`), text lines | `GetSmartFormContent` `GetSmartFormLayout` (the layout is computed from the same XML) |
| `ZMCP_SSF_UPLOAD.abap` | `ZMCP_SSF_UTILS` | SmartForm create / replace from Form Builder XML (`CL_SSF_FB_SMART_FORM` → `XML_UPLOAD` / `CHECK` / `STORE`) | `CreateSmartForm` |
| `ZMCP_SSF_DELETE.abap` | `ZMCP_SSF_UTILS` | SmartForm delete for local packages (`SSF_DELETE_FORM` + TADIR), dry run without `confirm` | `DeleteSmartForm` |
| `ZMCP_SSF_RENDER.abap` | `ZMCP_SSF_UTILS` | SmartForm render: calls the generated function module with `GETOTF` (no dialog, no spool) and converts the OTF to PDF with `CONVERT_OTF`; interface values are typed from the form's own interface | `RenderSmartForm` |
| `ZMCP_WL_JOB_USAGE.abap` | `ZMCP_WL_UTILS` | Background-job usage of a program (`TBTCO` / `TBTCP`) | `GetJobUsage` |
| `ZMCP_WL_TCODE_USAGE.abap` | `ZMCP_WL_UTILS` | Transaction usage from the ST03N monthly aggregates | `GetTcodeUsage` |

The two `ZMCP_WL_*` modules are ECC-only in the old contract: `GetTcodeUsage` and
`GetJobUsage` check `SAP_VERSION=ECC` before they are usable. On an S/4 system they are
declared unavailable with that reason, which is why those two tools answer
`NOT_IMPLEMENTED` instead of a wrong number.

## Installing them

The modules must be **remote-enabled**, and ADT's create call cannot set that flag, so
the two-step import is:

1. Create the function group, then the module (ADT is fine for both).
2. Turn on remote enablement through the SOAP RFC endpoint
 (`RPY_FUNCTIONMODULE_INSERT` with `REMOTE_CALL='X'`), then write the source and
 activate.

`tools/scripts/import-abap-bridges.mjs` does that in order and is safe to re-run: an
existing module is skipped, not overwritten.

```bash
npm run build
node tools/scripts/import-abap-bridges.mjs --profile <name> [--only <FM>]
```

## Why the sources look older than they could

The target is BASIS 7.54 as deployed here. The upstream sources of `ZMCP_ADT_DISPATCH`
and `ZMCP_ADT_TEXTPOOL` are written in newer syntax (`rpy_dyfield`, inline `DATA(...)`,
`/ui2/cl_abap_json_stringer`), which does not compile there; these files are the versions
that do. Keep them that way unless the minimum release changes.
