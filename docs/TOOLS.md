# Tool reference

Generated from `tools/catalog.json` — **335 tools**, frozen.
Do not edit this page by hand: run `node tools/scripts/gen-tools-doc.mjs`.

Every tool also accepts one argument the contract does not declare: `system`,
which selects the SAP system (see [USAGE.md](./USAGE.md#which-system-a-call-goes-to)).

## Shape

| | |
|---|---|
| Tools | 335 |
| Low-level (`*Low`) | 134 |
| Verbs | 16 |
| Non-object input schemas | 0 |

`Low` in a name means "low-level call sequence", not "twin of the tool next to it":
89 of these have no high-level sibling, so pick by what the tool needs, not by name.

## By verb

| Verb | Tools |
|---|---|
| Activate | 17 |
| Check | 14 |
| Create | 41 |
| Delete | 42 |
| Describe | 1 |
| Get | 67 |
| List | 2 |
| Lock | 18 |
| Other | 25 |
| Patch | 1 |
| Read | 19 |
| Run | 14 |
| Search | 1 |
| Unlock | 17 |
| Update | 40 |
| Validate | 16 |

## Activate (17)

| Tool | What it does |
|---|---|
| `ActivateBehaviorDefinitionLow` | [low-level] Activate an ABAP behavior definition. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same se… |
| `ActivateCdsViewLow` | [low-level] Activate an ABAP view (CDS view). Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateClassLow` | [low-level] Activate an ABAP class. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateClassTestClassesLow` | [low-level] Activate ABAP Unit test classes include for an existing class. Should be executed after updating and unlocking test classes. |
| `ActivateDataElementLow` | [low-level] Activate an ABAP data element. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateDomainLow` | [low-level] Activate an ABAP domain. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateFunctionGroupLow` | [low-level] Activate an ABAP function group. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateFunctionModuleLow` | [low-level] Activate an ABAP function module. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateGuiStatusLow` | [low-level] Activate an ABAP program to make GUI Status changes active. |
| `ActivateInterfaceLow` | [low-level] Activate an ABAP interface. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateMetadataExtensionLow` | [low-level] Activate an ABAP metadata extension. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same ses… |
| `ActivateObjectLow` | [low-level] Activate one or multiple ABAP repository objects. Works with any object type; URI is auto-generated from name and type. |
| `ActivateObjects` | [high-level] Activate a set of ABAP objects in a single call. Uses the ADT mass-activation endpoint (/sap/bc/adt/activation/runs) so cyclic references between siblings (e.g. mai… |
| `ActivateProgramLow` | [low-level] Activate an ABAP program. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateScreenLow` | [low-level] Activate an ABAP program to make Screen changes active. |
| `ActivateStructureLow` | [low-level] Activate an ABAP structure. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |
| `ActivateTableLow` | [low-level] Activate an ABAP table. Returns activation status and any warnings/errors. Can use session_id and session_state from GetSession to maintain the same session. |

## Check (14)

| Tool | What it does |
|---|---|
| `CheckBdefLow` | [low-level] Perform syntax check on an ABAP behavior definition. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain … |
| `CheckCdsViewLow` | [low-level] Perform syntax check on an ABAP view. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same sessio… |
| `CheckClassLow` | [low-level] Perform syntax check on an ABAP class. Can check existing class (active/inactive) or hypothetical source code. Returns syntax errors, warnings, and messages. Can use… |
| `CheckDataElementLow` | [low-level] Perform syntax check on an ABAP data element. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the sam… |
| `CheckDomainLow` | [low-level] Perform syntax check on an ABAP domain. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same sess… |
| `CheckFunctionGroupLow` | [low-level] Perform syntax check on an ABAP function group. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the s… |
| `CheckFunctionModuleLow` | [low-level] Perform syntax check on an ABAP function module. Returns syntax errors, warnings, and messages. Requires function group name. Can use session_id and session_state fr… |
| `CheckInterfaceLow` | [low-level] Perform syntax check on an ABAP interface. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same s… |
| `CheckMetadataExtensionLow` | [low-level] Perform syntax check on an ABAP metadata extension. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain t… |
| `CheckObjectLow` | [low-level] Perform syntax check on an ABAP object without activation. Returns syntax errors, warnings, and messages. |
| `CheckPackageLow` | [low-level] Perform syntax check on an ABAP package. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same ses… |
| `CheckProgramLow` | [low-level] Perform syntax check on an ABAP program. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same ses… |
| `CheckStructureLow` | [low-level] Perform syntax check on an ABAP structure. Returns syntax errors, warnings, and messages. Can use session_id and session_state from GetSession to maintain the same s… |
| `CheckTableLow` | [low-level] Perform syntax check on an ABAP table. Returns syntax errors, warnings, and messages. Requires session_id for stateful operations. Can use session_id and session_sta… |

## Create (41)

| Tool | What it does |
|---|---|
| `CreateBehaviorDefinition` | Create a new ABAP Behavior Definition (BDEF) in SAP system. Defines RAP business object behavior: CRUD operations, validations, determinations, actions, and draft handling. |
| `CreateBehaviorDefinitionLow` | [low-level] Create a new ABAP Behavior Definition. - use CreateBehaviorDefinition (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateBehaviorImplementation` | Create a new ABAP behavior implementation class for a behavior definition. Creates the object in initial state. Use UpdateBehaviorImplementation to set implementation code after… |
| `CreateBehaviorImplementationLow` | [low-level] Create a new ABAP behavior implementation class with full workflow (create, lock, update main source, update implementations, unlock, activate). - use CreateBehavior… |
| `CreateCdsUnitTest` | Create a CDS unit test class with CDS validation. Creates the test class in initial state. |
| `CreateCdsView` | Create CDS View or Classic View in SAP. Pass ddl_source to create the object, write the source and (optionally) activate it in one call - a failed write deletes the shell again.… |
| `CreateCdsViewLow` | [low-level] Create a new ABAP view. - use CreateCdsView (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateClass` | Create a new ABAP class in SAP system. Creates the class object in initial state. Use UpdateClass to set source code afterwards. |
| `CreateClassLow` | [low-level] Create a new ABAP class. - use CreateClass (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateDataElement` | Create a new ABAP data element in SAP system with all required steps: create, activate, and verify. |
| `CreateDataElementLow` | [low-level] Create a new ABAP data element. - use CreateDataElement (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateDomain` | Create a new ABAP domain in SAP system with all required steps: lock, create, check, unlock, activate, and verify. |
| `CreateDomainLow` | [low-level] Create a new ABAP domain. - use CreateDomain (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateFunctionGroup` | Create a new ABAP function group in SAP system. Function groups serve as containers for function modules. Uses stateful session for proper lock management. |
| `CreateFunctionGroupLow` | [low-level] Create a new ABAP function group. - use CreateFunctionGroup (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateFunctionModule` | Create a new ABAP function module within an existing function group. Creates the function module in initial state. Use UpdateFunctionModule to set source code afterwards. |
| `CreateFunctionModuleLow` | [low-level] Create a new ABAP function module. - use CreateFunctionModule (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateGuiStatus` | Create a new ABAP GUI Status on an existing program. Optionally activates after creation. |
| `CreateGuiStatusLow` | [low-level] Create a new ABAP GUI Status on an existing program. |
| `CreateInclude` | Create a new ABAP Include program (Type I, PROG/I) in SAP system. Creates the include object and registers it under the main program in D010INC. By default also auto-inserts an … |
| `CreateInterface` | Create a new ABAP interface in SAP system. Creates the interface object in initial state. Use UpdateInterface to set source code afterwards. |
| `CreateInterfaceLow` | [low-level] Create a new ABAP interface. - use CreateInterface (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateMetadataExtension` | Create a new ABAP Metadata Extension (DDLX) in SAP system. Defines Fiori UI annotations, field labels, search help, and list/object page layout for CDS views. |
| `CreateMetadataExtensionLow` | [low-level] Create a new ABAP Metadata Extension. - use CreateMetadataExtension (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreatePackage` | Create a new ABAP package in SAP system. Packages are containers for development objects and are essential for organizing code. |
| `CreatePackageLow` | [low-level] Create a new ABAP package. - use CreatePackage (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateProgram` | Create a new ABAP program (report) in SAP system. Creates the program object in initial state. Use UpdateProgram to set source code afterwards. |
| `CreateProgramLow` | [low-level] Create a new ABAP program. - use CreateProgram (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateScreen` | Create a new ABAP Screen (Dynpro) on an existing program. Optionally activates. |
| `CreateScreenLow` | [low-level] Create a new ABAP Screen (Dynpro) on an existing program. |
| `CreateServiceBinding` | Create ABAP service binding via ADT Business Services endpoint. XML is generated from high-level parameters. |
| `CreateServiceDefinition` | Create a new ABAP service definition for OData services. Service definitions define the structure and behavior of OData services. Uses stateful session for proper lock management. |
| `CreateSmartForm` | [writes] Create (or, with overwrite, replace) a Z/Y SmartForm from Form Builder XML — the format of SMARTFORMS > Utilities > Download. The form is checked and stored active (fun… |
| `CreateStructure` | Create a new ABAP structure in SAP system with fields and type references. Includes create, activate, and verify steps. |
| `CreateStructureLow` | [low-level] Create a new ABAP structure. - use CreateStructure (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateTable` | Create a new ABAP table via the ADT API. Creates the table object in initial state. Use UpdateTable to set DDL code afterwards. |
| `CreateTableLow` | [low-level] Create a new ABAP table. - use CreateTable (high-level) for full workflow with validation, lock, update, check, unlock, and activate. |
| `CreateTextElement` | Add a text element (text symbol, selection text, program title, or list heading) to an ABAP program. Optionally activates after write. |
| `CreateTransport` | Create a new ABAP transport request in SAP system for development objects. |
| `CreateTransportLow` | [low-level] Create a new ABAP transport request. |
| `CreateUnitTest` | Start an ABAP Unit test run for provided class test definitions. Returns run_id for status/result queries. |

## Delete (42)

| Tool | What it does |
|---|---|
| `DeleteBehaviorDefinition` | Delete an ABAP behavior definition from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteBehaviorDefinitionLow` | [low-level] Delete an ABAP behavior definition from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteBehaviorImplementation` | Delete an ABAP behavior implementation from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteCdsUnitTest` | Delete a CDS unit test class (global class). |
| `DeleteCdsView` | Delete an ABAP view from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteCdsViewLow` | [low-level] Delete an ABAP view from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteClass` | Delete an ABAP class from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteClassLow` | [low-level] Delete an ABAP class from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteDataElement` | Delete an ABAP data element from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteDataElementLow` | [low-level] Delete an ABAP data element from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteDomain` | Delete an ABAP domain from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteDomainLow` | [low-level] Delete an ABAP domain from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteFunctionGroup` | Delete an ABAP function group from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteFunctionGroupLow` | [low-level] Delete an ABAP function group from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteFunctionModule` | Delete an ABAP function module from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteFunctionModuleLow` | [low-level] Delete an ABAP function module from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteGuiStatus` | Delete an ABAP GUI Status from a program. Handles lock/unlock automatically. |
| `DeleteGuiStatusLow` | [low-level] Delete an ABAP GUI Status from a program. |
| `DeleteInclude` | Delete an existing ABAP Include program (Type I) from the SAP system via ADT API. If the include is referenced by a main program, provide main_program so the handler can first r… |
| `DeleteInterface` | Delete an ABAP interface from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteInterfaceLow` | [low-level] Delete an ABAP interface from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteLocalDefinitions` | Delete local definitions from an ABAP class by clearing the definitions include. Manages lock, update, unlock, and optional activation. |
| `DeleteLocalMacros` | Delete local macros from an ABAP class by clearing the macros include. Manages lock, update, unlock, and optional activation. Note: Macros are supported in older ABAP versions b… |
| `DeleteLocalTestClass` | Delete a local test class from an ABAP class by clearing the testclasses include. Manages lock, update, unlock, and optional activation of parent class. |
| `DeleteLocalTypes` | Delete local types from an ABAP class by clearing the implementations include. Manages lock, update, unlock, and optional activation. |
| `DeleteMetadataExtension` | Delete an ABAP metadata extension from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteMetadataExtensionLow` | [low-level] Delete an ABAP metadata extension from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteObjectLow` | [low-level] Delete an ABAP object via ADT deletion API. Transport request optional for $TMP objects. |
| `DeletePackageLow` | [low-level] Delete an ABAP package from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteProgram` | Delete an ABAP program from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteProgramLow` | [low-level] Delete an ABAP program from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteScreen` | Delete an ABAP Screen (Dynpro) from a program. Handles lock/unlock automatically. |
| `DeleteScreenLow` | [low-level] Delete an ABAP Screen (Dynpro) from a program. |
| `DeleteServiceBinding` | Delete ABAP service binding via ADT Business Services endpoint. |
| `DeleteServiceDefinition` | Delete an ABAP service definition from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteSmartForm` | [writes, destructive] Delete a Z/Y SmartForm of a local package ($TMP, $…) with its generated function module. Without confirm: true only reports what would be deleted (dry run)… |
| `DeleteStructure` | Delete an ABAP structure from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteStructureLow` | [low-level] Delete an ABAP structure from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteTable` | Delete an ABAP table from the SAP system. Includes deletion check before actual deletion. Transport request optional for $TMP objects. |
| `DeleteTableLow` | [low-level] Delete an ABAP table from the SAP system via ADT deletion API. Transport request optional for $TMP objects. |
| `DeleteTextElement` | Delete a text element from an ABAP program text pool. key="*" wipes all rows of the given text_type; text_type="*" wipes the whole pool. |
| `DeleteUnitTest` | Delete an ABAP Unit test run. Note: ADT does not support deleting unit test runs and will return an error. |

## Describe (1)

| Tool | What it does |
|---|---|
| `DescribeByList` | [read-only] Batch description for a list of ABAP objects. Input: objects: Array<{ name: string, type?: string }>. Each object may be of type: PROG/P, FUGR, PROG/I, CLAS/OC, FUGR… |

## Get (67)

| Tool | What it does |
|---|---|
| `GetAbapAST` | [read-only] Parse ABAP code and return AST (Abstract Syntax Tree) in JSON format. |
| `GetAbapSemanticAnalysis` | [read-only] Perform semantic analysis on ABAP code and return symbols, types, scopes, and dependencies. |
| `GetAbapSystemSymbols` | [read-only] Resolve ABAP symbols from semantic analysis with SAP system information including types, scopes, descriptions, and packages. |
| `GetAdtTypes` | [read-only] Retrieve all valid ADT object types (CLAS, TABL, PROG, DEVC, FUGR, INTF, DDLS, DTEL, DOMA, SRVD, SRVB, BDEF, DDLX, etc.) or validate a specific type name. |
| `GetBadiImplementations` | [read-only] Find implementations of a (classic) BAdI definition. Use during symptom analysis when a standard SAP BAdI is implicated — answers 'which Z class extends this standar… |
| `GetBehaviorDefinition` | Retrieve ABAP behavior definition definition. Supports reading active or inactive version. |
| `GetBehaviorImplementation` | Retrieve ABAP behavior implementation definition. Supports reading active or inactive version. |
| `GetCdsUnitTest` | Retrieve CDS unit test run status and result for a previously started run_id. |
| `GetCdsUnitTestResult` | Retrieve CDS unit test run result for a run_id. |
| `GetCdsUnitTestStatus` | Retrieve CDS unit test run status for a run_id. |
| `GetCdsView` | Retrieve ABAP view definition. Supports reading active or inactive version. |
| `GetClass` | Retrieve ABAP class source code. Supports reading active or inactive version. |
| `GetClassUnitTestResultLow` | [low-level] Retrieve ABAP Unit run result (ABAPUnit or JUnit XML) for a completed run_id. |
| `GetClassUnitTestStatusLow` | [low-level] Retrieve ABAP Unit run status XML for a previously started run_id. |
| `GetDataElement` | Retrieve ABAP data element definition. Supports reading active or inactive version. |
| `GetDomain` | Retrieve ABAP domain definition. Supports reading active or inactive version. |
| `GetEnhancementImpl` | [read-only] Retrieve source code of a specific enhancement implementation by its name and enhancement spot. |
| `GetEnhancements` | [read-only] Retrieve a list of enhancements for a given ABAP object. |
| `GetEnhancementSpot` | [read-only] Retrieve metadata and list of implementations for a specific enhancement spot. |
| `GetFunctionGroup` | Retrieve ABAP function group definition. Supports reading active or inactive version. |
| `GetFunctionModule` | Retrieve ABAP function module definition. Supports reading active or inactive version. |
| `GetGuiStatus` | Get ABAP GUI Status definition including statuses, function codes, menus, toolbars, and titles. A large program interface is big: pass status_name and/or function_codes to narro… |
| `GetGuiStatusList` | [read-only] List all GUI statuses belonging to an ABAP program. |
| `GetInactiveObjects` | [read-only] Get a list of inactive ABAP objects — modified but not yet activated, pending activation. Shows classes, tables, CDS views, and other objects awaiting activation. |
| `GetInclude` | [read-only] Retrieve source code of a specific ABAP include file. |
| `GetIncludesList` | [read-only] Recursively discover and list ALL include files within an ABAP program or include. |
| `GetInterface` | Retrieve ABAP interface definition. Supports reading active or inactive version. |
| `GetJobUsage` | [read-only] Check whether programs are used as background job steps (SM37 jobs, TBTCO/TBTCP): true when the program is a step of a job that is scheduled now (released/ready/acti… |
| `GetLocalDefinitions` | Retrieve local definitions source code from a class (definitions include). Supports reading active or inactive version. |
| `GetLocalMacros` | Retrieve local macros source code from a class (macros include). Supports reading active or inactive version. Note: Macros are supported in older ABAP versions but not in newer … |
| `GetLocalTestClass` | Retrieve local test class source code from a class. Supports reading active or inactive version. |
| `GetLocalTypes` | Retrieve local types source code from a class (implementations include). Supports reading active or inactive version. |
| `GetMetadataExtension` | Retrieve ABAP metadata extension definition. Supports reading active or inactive version. |
| `GetNodeStructureLow` | [low-level] Fetch node structure from ADT repository. Used for object tree navigation and structure discovery. Can use session_id and session_state from GetSession to maintain t… |
| `GetObjectInfo` | [read-only] Return ABAP object tree structure for packages (DEVC), classes (CLAS), programs (PROG), function groups (FUGR), and other objects. Shows root, group nodes, and termi… |
| `GetObjectNodeFromCache` | [read-only] Returns a node from the in-memory objects list cache by OBJECT_TYPE, OBJECT_NAME, TECH_NAME, and expands OBJECT_URI if present. |
| `GetObjectsByType` | [read-only] Retrieves all ABAP objects of a specific type (classes, tables, programs, interfaces, etc.) under a given parent node. Useful for listing all objects of one type wit… |
| `GetObjectsList` | [read-only] Recursively retrieves all child ABAP repository objects for a given parent — programs (PROG), function groups (FUGR), classes (CLAS), packages (DEVC), and other comp… |
| `GetObjectStructure` | [read-only] Retrieve ADT object structure as a compact JSON tree. |
| `GetObjectStructureLow` | [low-level] Retrieve ADT object structure as compact JSON tree. Returns XML response with object structure tree. Can use session_id and session_state from GetSession to maintain… |
| `GetPackage` | Retrieve ABAP package metadata (description, super-package, etc.). Supports reading active or inactive version. |
| `GetPackageContents` | [read-only] Retrieve objects inside an ABAP package as a flat list. Supports recursive traversal of subpackages. |
| `GetPackageTree` | [high-level] Retrieve complete package tree structure including subpackages and objects. Returns hierarchical tree with object names, types, and descriptions. |
| `GetProgFullCode` | [read-only] Returns the full code for a program or function group, including all includes, in tree traversal order. Use output="file" to get paths + outlines instead of the code. |
| `GetProgram` | Retrieve ABAP program definition. Supports reading active or inactive version. |
| `GetScreen` | Get ABAP Screen (Dynpro) definition including metadata, fields, and flow logic source code. |
| `GetScreensList` | [read-only] List all screens (dynpros) belonging to an ABAP program. |
| `GetServiceBinding` | Retrieve ABAP service binding source/metadata by name via ADT Business Services endpoint. |
| `GetServiceDefinition` | Retrieve ABAP service definition definition. Supports reading active or inactive version. |
| `GetSession` | [read-only] Get a new session ID and current session state (cookies, CSRF token) for reuse across multiple ADT operations. Use this to maintain the same session and lock handle … |
| `GetSmartFormContent` | [read-only] Read what a SmartForm prints, for a preview: per page and window (position in mm) the content tree — text nodes with their lines (paragraph format + text with inline… |
| `GetSmartFormLayout` | [read-only] Read the page and window layout of a SmartForm (active version; a never-activated form is read from its saved version, then `active` is false): per page the format, … |
| `GetSqlQuery` | [read-only] Execute ABAP SQL SELECT queries on database tables and CDS views via SAP ADT Data Preview API. Use for ad-hoc data retrieval, row counts, and filtered queries. |
| `GetStructure` | Retrieve ABAP structure definition. Supports reading active or inactive version. |
| `GetTable` | Retrieve ABAP table definition. Supports reading active or inactive version. |
| `GetTableContents` | [read-only] Retrieve contents (data preview) of an ABAP database table or CDS view, like SE16. Compact by default: column names only, empty cell values left out of each row, 20 … |
| `GetTcodeUsage` | [read-only] Check whether transactions were used in the last N months, from the ST03N workload monthly aggregates. Returns one boolean per transaction plus `coverage` = months t… |
| `GetTextElement` | Read ABAP program text pool (text symbols, selection texts, title, headings). Optionally filter by text_type / key. |
| `GetTransaction` | [read-only] Retrieve ABAP transaction (t-code) details from TSTC / TSTCP — program, screen, and kind (program, parameter transaction with its target t-code and parameters such a… |
| `GetTransport` | [read-only] Retrieve ABAP transport request information including metadata, included objects, and status from SAP system. |
| `GetTypeInfo` | [read-only] Retrieve ABAP type information for domains (DOMA), data elements (DTEL), table types, and structures. Returns field definitions, value ranges, fixed values, and DDIC… |
| `GetUnitTest` | Retrieve ABAP Unit test run status and result for a previously started run_id. |
| `GetUnitTestResult` | Retrieve ABAP Unit test run result for a run_id. |
| `GetUnitTestStatus` | Retrieve ABAP Unit test run status for a run_id. |
| `GetUsageSnippets` | [read-only] Line-level where-used hits: for each referencing object, the source lines that use the searched object, with uri ".../source/main#start=<line>,<col>", line, column a… |
| `GetVirtualFoldersLow` | [low-level] Retrieve hierarchical virtual folder contents from ADT information system. Used for browsing ABAP objects by package, group, type, etc. |
| `GetWhereUsed` | [read-only] Find where-used references (cross-references, usages, dependencies) for ABAP objects — classes, interfaces, tables, data elements, programs, function modules, etc. R… |

## List (2)

| Tool | What it does |
|---|---|
| `ListServiceBindingTypes` | List available service binding types (for example ODataV2/ODataV4) from ADT Business Services endpoint. |
| `ListTransports` | [read-only] List transport requests for the current or specified user. Returns modifiable and/or released workbench and customizing requests. |

## Lock (18)

| Tool | What it does |
|---|---|
| `LockBehaviorDefinitionLow` | [low-level] Lock an ABAP behavior definition for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockBehaviorImplementationLow` | [low-level] Lock an ABAP behavior implementation class for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockCdsViewLow` | [low-level] Lock an ABAP view for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockClassLow` | [low-level] Lock an ABAP class for modification. Uses session from HandlerContext. Returns lock handle that must be used in subsequent update/unlock operations. |
| `LockClassTestClassesLow` | [low-level] Lock ABAP Unit test classes include (CLAS/OC testclasses) for the specified class. Returns a test_classes_lock_handle for subsequent update/unlock operations using t… |
| `LockDataElementLow` | [low-level] Lock an ABAP data element for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockDomainLow` | [low-level] Lock an ABAP domain for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockFunctionGroupLow` | [low-level] Lock an ABAP function group for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockFunctionModuleLow` | [low-level] Lock an ABAP function module for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockGuiStatusLow` | [low-level] Lock a program for GUI Status modification. Returns lock handle for subsequent update/unlock operations. |
| `LockInterfaceLow` | [low-level] Lock an ABAP interface for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockMetadataExtensionLow` | [low-level] Lock an ABAP metadata extension for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockObjectLow` | [low-level] Lock an ABAP object for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockPackageLow` | [low-level] Lock an ABAP package for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. Requires super_package. |
| `LockProgramLow` | [low-level] Lock an ABAP program for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockScreenLow` | [low-level] Lock a program for Screen modification. Returns lock handle for subsequent operations. |
| `LockStructureLow` | [low-level] Lock an ABAP structure for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |
| `LockTableLow` | [low-level] Lock an ABAP table for modification. Returns lock handle that must be used in subsequent update/unlock operations with the same session_id. |

## Other (25)

| Tool | What it does |
|---|---|
| `HandlerActivate` | Activate operation. Single mode(object_name*, object_adt_type*). Batch mode(objects[].name*, objects[].type*). |
| `HandlerCdsUnitTestResult` | CDS unit test result. object_type: not used. Required: run_id*. Optional: with_navigation_uris, format(abapunit\|junit). Response: JSON. |
| `HandlerCdsUnitTestStatus` | CDS unit test status. object_type: not used. Required: run_id*. Optional: with_long_polling. Response: JSON. |
| `HandlerCheckRun` | CheckRun operation (syntax, no activation). object_type required: CLASS(object_name*), PROGRAM(object_name*), INTERFACE(object_name*), FUNCTION_GROUP(object_name*), FUNCTION_MOD… |
| `HandlerCreate` | Create operation. object_type required: PACKAGE(package_name*), DOMAIN(domain_name*), DATA_ELEMENT(data_element_name*), TABLE(table_name*), STRUCTURE(structure_name*), VIEW(view… |
| `HandlerDelete` | Delete operation. object_type required: PACKAGE(package_name*), DOMAIN(domain_name*), DATA_ELEMENT(data_element_name*), TABLE(table_name*), STRUCTURE(structure_name*), VIEW(view… |
| `HandlerDumpList` | Runtime dump list. object_type: not used. Required: none. Optional: user, inlinecount, top, skip, orderby. Response: JSON. |
| `HandlerDumpView` | Runtime dump view. object_type: not used. Required: dump_id*. Optional: view(default\|summary\|formatted). Response: JSON. |
| `HandlerGet` | Read operation. object_type required: PACKAGE(package_name*), DOMAIN(domain_name*), DATA_ELEMENT(data_element_name*), TABLE(table_name*), STRUCTURE(structure_name*), VIEW(view_n… |
| `HandlerLock` | Lock operation. object_type required: CLASS(object_name*), PROGRAM(object_name*), INTERFACE(object_name*), FUNCTION_GROUP(object_name*), FUNCTION_MODULE(object_name*), TABLE(obj… |
| `HandlerProfileList` | Runtime profiling list. object_type: not used. Required: none. Response: JSON. |
| `HandlerProfileRun` | Runtime profiling run. object_type: not used. Required: target_type*(CLASS\|PROGRAM) + class_name* for CLASS or program_name* for PROGRAM. Optional profiling flags and descripti… |
| `HandlerProfileView` | Runtime profiling view. object_type: not used. Required: trace_id_or_uri*, view*(hitlist\|statements\|db_accesses). Optional: with_system_events, id, with_details, auto_drill_do… |
| `HandlerServiceBindingListTypes` | Service binding types list. object_type: not used. Required: none. Optional: response_format(xml\|json\|plain). Response: XML/JSON/plain by response_format. |
| `HandlerServiceBindingValidate` | Service binding validate before create. object_type: not used. Required: service_binding_name*, service_definition_name*. Optional: service_binding_version, package_name, descri… |
| `HandlerTransportCreate` | Transport create. object_type: not used. Required: description*. Optional: transport_type(workbench\|customizing), target_system, owner. Response: JSON. |
| `HandlerUnitTestResult` | ABAP Unit result. object_type: not used. Required: run_id*. Optional: with_navigation_uris, format(abapunit\|junit). Response: JSON. |
| `HandlerUnitTestRun` | ABAP Unit run. object_type: not used. Required: tests[]{container_class*, test_class*}. Optional: title, context, scope, risk_level, duration. Response: JSON. |
| `HandlerUnitTestStatus` | ABAP Unit status. object_type: not used. Required: run_id*. Optional: with_long_polling. Response: JSON. |
| `HandlerUnlock` | Unlock operation. object_type required: CLASS(object_name*, lock_handle*, session_id*), PROGRAM(object_name*, lock_handle*, session_id*), INTERFACE(object_name*, lock_handle*, s… |
| `HandlerUpdate` | Update operation. object_type required: PACKAGE(package_name*), DOMAIN(domain_name*), DATA_ELEMENT(data_element_name*), TABLE(table_name*), STRUCTURE(structure_name*), VIEW(view… |
| `HandlerValidate` | Validate before create only. object_type required: CLASS(object_name*), PROGRAM(object_name*), INTERFACE(object_name*), FUNCTION_GROUP(object_name*), FUNCTION_MODULE(object_name… |
| `ReloadProfile` | [system] Reload the active SAP profile from .sc4sap/active-profile.txt and reset the cached connection. Called by the sc4sap plugin after switching profiles. Returns the newly a… |
| `RenderSmartForm` | [runs the form, no output] The output of a SmartForm as SAP prints it, for given interface values: calls the generated function module with GETOTF (no dialog, no print, no spool… |
| `WriteTextElementsBulk` | Register many ABAP text elements (R/I/S/H) in ONE tool call via a single TPOOL RFC write. Use instead of calling CreateTextElement N times. With activate=false (default) the poo… |

## Patch (1)

| Tool | What it does |
|---|---|
| `PatchGuiStatus` | Row-level merge into an existing ABAP GUI Status definition. Fetches current CUA → merges the caller-supplied changes (by natural key) → writes merged result back. Rows / fields… |

## Read (19)

| Tool | What it does |
|---|---|
| `ReadBehaviorDefinition` | [read-only] Read ABAP behavior definition source code and metadata (package, responsible, description, etc.). |
| `ReadBehaviorImplementation` | [read-only] Read ABAP behavior implementation source code and metadata (package, responsible, description, etc.). |
| `ReadCdsView` | [read-only] Read ABAP view (CDS view) source code and metadata (package, responsible, description, etc.). |
| `ReadClass` | [read-only] Read ABAP class source code and metadata (package, responsible, description, etc.). |
| `ReadDataElement` | [read-only] Read ABAP data element definition and metadata (package, responsible, description, etc.). |
| `ReadDomain` | [read-only] Read ABAP domain definition and metadata (package, responsible, description, etc.). |
| `ReadFunctionGroup` | [read-only] Read ABAP function group source code and metadata (package, responsible, description, etc.). |
| `ReadFunctionModule` | [read-only] Read ABAP function module source code and metadata (package, responsible, description, etc.). |
| `ReadGuiStatus` | [read-only] Read ABAP GUI Status definition (statuses, function codes, menus, toolbars, titles) for a program. |
| `ReadInterface` | [read-only] Read ABAP interface source code and metadata (package, responsible, description, etc.). |
| `ReadMetadataExtension` | [read-only] Read ABAP metadata extension (DDLX) source code and metadata (package, responsible, description, etc.). |
| `ReadPackage` | [read-only] Read ABAP package definition and metadata (super-package, responsible, description, etc.). |
| `ReadProgram` | [read-only] Read ABAP program source code and metadata (package, responsible, description, etc.). |
| `ReadScreen` | [read-only] Read ABAP Screen (Dynpro) flow logic source code, fields, and metadata. |
| `ReadServiceBinding` | [read-only] Read ABAP service binding source/payload and metadata (package, responsible, description, etc.). |
| `ReadServiceDefinition` | [read-only] Read ABAP service definition source code and metadata (package, responsible, description, etc.). |
| `ReadStructure` | [read-only] Read ABAP structure definition and metadata (package, responsible, description, etc.). |
| `ReadTable` | [read-only] Read ABAP table definition and metadata (package, responsible, description, etc.). |
| `ReadTextElementsBulk` | Read every text element (R/I/S/H) of a program in ONE call via the TPOOL RFC. Partitions rows by type and returns structured arrays. Use this instead of calling GetTextElement p… |

## Run (14)

| Tool | What it does |
|---|---|
| `RunClassUnitTestsLow` | [low-level] Start an ABAP Unit test run for provided class test definitions. Returns run_id extracted from SAP response headers. |
| `RuntimeAnalyzeDump` | [runtime] Read runtime dump by ID and return key facts (runtime error, exception, program, termination object/line, user, date, chapter index). Set include_payload=false for fac… |
| `RuntimeAnalyzeProfilerTrace` | [runtime] Read profiler trace view and return compact analysis summary (totals + top entries). |
| `RuntimeCreateProfilerTraceParameters` | [runtime] Create ABAP profiler trace parameters and return profilerId (URI) for profiled execution. |
| `RuntimeGetDumpById` | [runtime] Read a specific ABAP runtime dump by dump ID. Default view (~7 KB): dump metadata, termination link (object + line) and chapter index. Use response_mode="summary" for … |
| `RuntimeGetGatewayErrorLog` | [runtime] List SAP Gateway error log (/IWFND/ERROR_LOG) or get error detail. Returns structured entries with type, shortText, transactionId, dateTime, username. With error_url r… |
| `RuntimeGetProfilerTraceData` | [runtime] Read profiler trace data by trace id/uri: hitlist, statements, or db accesses. Returns parsed JSON payload. |
| `RuntimeListDumps` | [runtime] List ABAP runtime dumps with optional user filter and paging. Returns parsed JSON payload. Each entry's HTML summary (~13 KB per dump) is omitted unless include_summar… |
| `RuntimeListFeeds` | [runtime] List available ADT runtime feeds or read a specific feed type. Feed types: dumps, system_messages, gateway_errors. Without feed_type returns available feed descriptors. |
| `RuntimeListProfilerTraceFiles` | [runtime] List ABAP profiler trace files available in ADT runtime. Returns parsed JSON payload. |
| `RuntimeListSystemMessages` | [runtime] List SM02 system messages. Returns structured entries with id, title, text, severity, validity period, and author. |
| `RuntimeRunClassWithProfiling` | [runtime] Execute ABAP class with profiler enabled and return created profilerId + traceId. |
| `RuntimeRunProgramWithProfiling` | [runtime] Execute ABAP program with profiler enabled and return created profilerId + traceId. |
| `RunUnitTest` | Start an ABAP Unit test run for provided test definitions. Returns run_id for status/result queries. On legacy systems (ECC / BASIS < 7.50) the run is synchronous: the result is… |

## Search (1)

| Tool | What it does |
|---|---|
| `SearchObject` | [read-only] Find, search, locate, or check if an ABAP repository object exists by name or wildcard pattern (e.g. 'ZOK*'). Use this tool to answer questions like 'is there a prog… |

## Unlock (17)

| Tool | What it does |
|---|---|
| `UnlockBehaviorDefinitionLow` | [low-level] Unlock an ABAP behavior definition after modification. Must use the same session_id and lock_handle from LockBehaviorDefinition operation. |
| `UnlockCdsViewLow` | [low-level] Unlock an ABAP view after modification. Must use the same session_id and lock_handle from LockView operation. |
| `UnlockClassLow` | [low-level] Unlock an ABAP class after modification. Uses session from HandlerContext. Must use the same lock_handle from LockClass operation. |
| `UnlockClassTestClassesLow` | [low-level] Unlock ABAP Unit test classes include for a class using the test_classes_lock_handle obtained from LockClassTestClassesLow. |
| `UnlockDataElementLow` | [low-level] Unlock an ABAP data element after modification. Must use the same session_id and lock_handle from LockDataElement operation. |
| `UnlockDomainLow` | [low-level] Unlock an ABAP domain after modification. Must use the same session_id and lock_handle from LockDomain operation. |
| `UnlockFunctionGroupLow` | [low-level] Unlock an ABAP function group after modification. Must use the same session_id and lock_handle from LockFunctionGroup operation. |
| `UnlockFunctionModuleLow` | [low-level] Unlock an ABAP function module after modification. Must use the same session_id and lock_handle from LockFunctionModule operation. |
| `UnlockGuiStatusLow` | [low-level] Unlock a program after GUI Status modification. Requires lock handle from LockGuiStatusLow. |
| `UnlockInterfaceLow` | [low-level] Unlock an ABAP interface after modification. Must use the same session_id and lock_handle from LockInterface operation. |
| `UnlockMetadataExtensionLow` | [low-level] Unlock an ABAP metadata extension after modification. Must use the same session_id and lock_handle from LockMetadataExtension operation. |
| `UnlockObjectLow` | [low-level] Unlock an ABAP object after modification. Must use the same session_id and lock_handle from the LockObject operation. |
| `UnlockPackageLow` | [low-level] Unlock an ABAP package after modification. Requires lock handle from LockObject and superPackage. - must use the same session_id and lock_handle from LockObject. |
| `UnlockProgramLow` | [low-level] Unlock an ABAP program after modification. Must use the same session_id and lock_handle from LockProgram operation. |
| `UnlockScreenLow` | [low-level] Unlock a program after Screen modification. |
| `UnlockStructureLow` | [low-level] Unlock an ABAP structure after modification. Must use the same session_id and lock_handle from LockStructure operation. |
| `UnlockTableLow` | [low-level] Unlock an ABAP table after modification. Must use the same session_id and lock_handle from LockTable operation. |

## Update (40)

| Tool | What it does |
|---|---|
| `UpdateBehaviorDefinition` | Update source code of an ABAP Behavior Definition (BDEF). Modifies RAP business object behavior: CRUD operations, validations, determinations, actions, and draft handling. Alter… |
| `UpdateBehaviorDefinitionLow` | [low-level] Update source code of an existing ABAP behavior definition. Requires lock handle from LockObject. - use UpdateBehaviorDefinition (high-level) for full workflow with … |
| `UpdateBehaviorImplementation` | Update source code of an existing ABAP behavior implementation class. Updates both main source (with FOR BEHAVIOR OF clause) and implementations include. Uses stateful session w… |
| `UpdateCdsUnitTest` | Update a CDS unit test class local test class source code. |
| `UpdateCdsView` | Update DDL source code of an existing CDS View or Classic View. Locks the view, checks new code, uploads new DDL source, unlocks, and optionally activates. |
| `UpdateCdsViewLow` | [low-level] Update DDL source code of an existing CDS View or Classic View. Requires lock handle from LockObject. - use UpdateCdsView (high-level) for full workflow with lock/un… |
| `UpdateClass` | Update source code of an existing ABAP class. Locks, checks, updates, unlocks, and optionally activates. Alternatively pass source_file (local path, read server-side) or patch (… |
| `UpdateClassLow` | [low-level] Update source code of an existing ABAP class. Uses session from HandlerContext. Requires lock handle from LockClass operation. - use UpdateClass (high-level) for ful… |
| `UpdateClassTestClassesLow` | [low-level] Upload ABAP Unit test include source code for an existing class. Requires test_classes_lock_handle from LockClassTestClassesLow. |
| `UpdateDataElement` | Update an existing ABAP data element in SAP system. Workflow: 1. Gets domain info (if type_kind is 'domain') to extract dataType/length/decimals 2. Acquires lock on the data ele… |
| `UpdateDataElementLow` | [low-level] Update properties of an existing ABAP data element. Requires lock handle from LockObject. - use UpdateDataElement (high-level) for full workflow with lock/unlock/act… |
| `UpdateDomain` | Update an existing ABAP domain in SAP system. Workflow: 1. Acquires lock on the domain 2. Updates domain with provided parameters (complete replacement) 3. Performs syntax check… |
| `UpdateDomainLow` | [low-level] Update properties of an existing ABAP domain. Requires lock handle from LockObject. - use UpdateDomain (high-level) for full workflow with lock/unlock/activate. |
| `UpdateFunctionGroup` | Update metadata (description) of an existing ABAP function group. Function groups are containers for function modules and don't have source code to update directly. Uses statefu… |
| `UpdateFunctionModule` | Update source code of an existing ABAP function module. Locks the function module, uploads new source code, and unlocks. Optionally activates after update. Use this to modify ex… |
| `UpdateFunctionModuleLow` | [low-level] Update source code of an existing ABAP function module. Requires lock handle from LockObject and function group name. - use UpdateFunctionModule (high-level) for ful… |
| `UpdateGuiStatus` | ⚠️ FULL REPLACE — overwrites the entire GUI Status definition (all 12 CUA tables) for the program. Any row or field you omit is DROPPED. Always Read (ReadGuiStatus) → modify → U… |
| `UpdateGuiStatusLow` | [low-level] Update an ABAP GUI Status definition. Provide full CUA data (from ReadGuiStatus) with modifications. |
| `UpdateInclude` | Update source code of an existing ABAP Include program (Type I). Locks the include, uploads new source code, and unlocks. Optionally activates after update. Use this instead of … |
| `UpdateInterface` | Update source code of an existing ABAP interface. Uses stateful session with proper lock/unlock mechanism. Lock handle and transport number are passed in URL parameters. Alterna… |
| `UpdateInterfaceLow` | [low-level] Update source code of an existing ABAP interface. Requires lock handle from LockObject. - use UpdateInterface (high-level) for full workflow with lock/unlock/activat… |
| `UpdateLocalDefinitions` | Update local definitions in an ABAP class (definitions include). Manages lock, check, update, unlock, and optional activation. |
| `UpdateLocalMacros` | Update local macros in an ABAP class (macros include). Manages lock, check, update, unlock, and optional activation. Note: Macros are supported in older ABAP versions but not in… |
| `UpdateLocalTestClass` | Update a local test class in an ABAP class. Manages lock, check, update, unlock, and optional activation of parent class. |
| `UpdateLocalTypes` | Update local types in an ABAP class (implementations include). Manages lock, check, update, unlock, and optional activation. |
| `UpdateMetadataExtension` | Update source code of an ABAP Metadata Extension (DDLX). Modifies Fiori UI annotations, field labels, search help, and list/object page layout for CDS views. Alternatively pass … |
| `UpdateMetadataExtensionLow` | [low-level] Update source code of an existing ABAP metadata extension. Requires lock handle from LockObject. - use UpdateMetadataExtension (high-level) for full workflow with lo… |
| `UpdatePackageLow` | [low-level] Update description of an existing ABAP package. Requires lock handle from LockObject and superPackage. - use UpdatePackageSource for full workflow with lock/unlock. |
| `UpdateProgram` | Update source code of an existing ABAP program. Locks the program, checks new code, uploads new source code, and unlocks. Optionally activates after update. Use this to modify e… |
| `UpdateProgramLow` | [low-level] Update source code of an existing ABAP program. Requires lock handle from LockObject. - use UpdateProgram (high-level) for full workflow with lock/unlock/activate. A… |
| `UpdateScreen` | Update an ABAP Screen (Dynpro) definition. Provide full screen data as JSON. Handles lock/unlock automatically. |
| `UpdateScreenLow` | [low-level] Update an ABAP Screen (Dynpro) definition. Provide full screen data as JSON. |
| `UpdateServiceBinding` | Update publication state for ABAP service binding via AdtServiceBinding workflow. |
| `UpdateServiceDefinition` | Update source code of an existing ABAP service definition. Uses stateful session with proper lock/unlock mechanism. Alternatively pass source_file (local path, read server-side)… |
| `UpdateStructure` | Update DDL source code of an existing ABAP structure. Locks the structure, uploads new DDL source, and unlocks. Optionally activates after update. Use this to modify existing st… |
| `UpdateStructureLow` | [low-level] Update DDL source code of an existing ABAP structure. Requires lock handle from LockObject. - use UpdateStructureSource for full workflow with lock/unlock. |
| `UpdateTable` | Update DDL source code of an existing ABAP table. Locks the table, uploads new DDL source, and unlocks. Optionally activates after update. Use this to modify existing tables wit… |
| `UpdateTableLow` | [low-level] Update DDL source code of an existing ABAP table. Requires lock handle from LockObject. - use CreateTable for full workflow with lock/unlock. |
| `UpdateTextElement` | Update an existing text element in an ABAP program text pool. Handles lock/unlock automatically. |
| `UpdateUnitTest` | Update an ABAP Unit test run. Note: ADT does not support updating unit test runs and will return an error. |

## Validate (16)

| Tool | What it does |
|---|---|
| `ValidateBehaviorDefinitionLow` | [low-level] Validate an ABAP behavior definition name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can … |
| `ValidateBehaviorImplementationLow` | [low-level] Validate an ABAP behavior implementation class name before creation. Checks if the name is valid and available. Returns validation result with success status and mes… |
| `ValidateCdsViewLow` | [low-level] Validate an ABAP view name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use session_id … |
| `ValidateClassLow` | [low-level] Validate an ABAP class name before creation. Checks if the name is valid, available, and validates package, description, and superclass if provided. Can use session_… |
| `ValidateDataElementLow` | [low-level] Validate an ABAP data element name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use ses… |
| `ValidateDomainLow` | [low-level] Validate an ABAP domain name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use session_i… |
| `ValidateFunctionGroupLow` | [low-level] Validate an ABAP function group name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use s… |
| `ValidateFunctionModuleLow` | [low-level] Validate an ABAP function module name before creation. Checks if the name is valid and available. Requires function group name. Can use session_id and session_state … |
| `ValidateInterfaceLow` | [low-level] Validate an ABAP interface name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use sessio… |
| `ValidateMetadataExtensionLow` | [low-level] Validate an ABAP metadata extension name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can u… |
| `ValidateObjectLow` | [low-level] Validate an ABAP object name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use session_i… |
| `ValidatePackageLow` | [low-level] Validate an ABAP package name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use session_… |
| `ValidateProgramLow` | [low-level] Validate an ABAP program name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use session_… |
| `ValidateServiceBinding` | Validate service binding parameters (name, service definition, package, version) via ADT validation endpoint. |
| `ValidateStructureLow` | [low-level] Validate an ABAP structure name before creation. Checks if the name is valid and available. Returns validation result with success status and message. Can use sessio… |
| `ValidateTableLow` | [low-level] Validate an ABAP table name before creation. Checks if the name is valid and available. Can use session_id and session_state from GetSession to maintain the same ses… |
