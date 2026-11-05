FUNCTION zmcp_ssf_delete
  IMPORTING
    VALUE(iv_params)  TYPE string
  EXPORTING
    VALUE(ev_subrc)   TYPE i
    VALUE(ev_message) TYPE string
    VALUE(ev_result)  TYPE string.

*----------------------------------------------------------------------*
* SmartForm delete (local packages only)
*
* iv_params (JSON):
*   { "form_name": "ZFORM", "confirm": false }
*
* Without confirm it only reports what would be deleted (dry run), the same rule as upstream:
* a form delete cannot be undone. Packages under a transport (DEVCLASS not starting with $)
* are always refused - such a delete belongs to a transport request, done in SMARTFORMS.
*
* Three things are deleted:
*   1. SSF_DELETE_FORM - directory / content / texts (STXF* tables)
*   2. TADIR entry (TR_TADIR_INTERFACE, wi_test_modus = ' ')
*   3. generated function module - not deleted in this version, only reported in the result
*----------------------------------------------------------------------*

  DATA: BEGIN OF ls_input,
          form_name TYPE string,   " SmartForm name
          confirm   TYPE string,   " 'X' = really delete; empty = dry run
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          form_name    TYPE string, " SmartForm name
          dry_run      TYPE string, " 'X' = reported only, nothing deleted
          deleted      TYPE string, " 'X' = deleted
          package_name TYPE string, " package it was in
          generated_fm TYPE string, " generated function module (not deleted here, needs manual follow-up)
          tadir_left   TYPE string, " whether a TADIR entry is left behind after the delete
        END OF ls_result.

  DATA: lv_form    TYPE tdsfname,
        lv_tadir   TYPE tadir,
        lv_fmnumb  TYPE tdfmnumb,
        lv_fmnumb_t TYPE tdfmnumb,
        lv_fm_name TYPE rs38l_fnam,
        lv_left    TYPE tadir-obj_name,
        lo_sform   TYPE REF TO cl_ssf_fb_smart_form.

  CLEAR: ev_subrc, ev_message, ev_result, ls_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_form = ls_input-form_name.
  TRANSLATE lv_form TO UPPER CASE.

  IF lv_form IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'FORM_NAME is required'.
    RETURN.
  ENDIF.

  SELECT SINGLE * FROM tadir INTO lv_tadir
    WHERE pgmid = 'R3TR' AND object = 'SSFO' AND obj_name = lv_form.
  IF sy-subrc <> 0.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } does not exist|.
    RETURN.
  ENDIF.

  IF lv_tadir-devclass IS NOT INITIAL AND lv_tadir-devclass(1) <> '$'.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } belongs to package { lv_tadir-devclass }, which is not local|.
    ev_message = |{ ev_message }: delete it through its transport (SMARTFORMS), not from here|.
    RETURN.
  ENDIF.

* Name of the generated function module (reported only, not deleted).
  TRY.
      CREATE OBJECT lo_sform.
      CALL METHOD lo_sform->load
        EXPORTING
          im_formname    = lv_form
          im_active      = 'X'
        IMPORTING
          ex_fmnumb      = lv_fmnumb
          ex_fmnumb_test = lv_fmnumb_t.
    CATCH cx_ssf_fb.
      CLEAR lv_fmnumb.
  ENDTRY.

  IF lv_fmnumb IS NOT INITIAL.
    CALL FUNCTION 'SSF_FUNCTION_MODULE_NAME'
      EXPORTING
        formname = lv_form
      IMPORTING
        fm_name  = lv_fm_name
      EXCEPTIONS
        OTHERS   = 1.
    IF sy-subrc <> 0.
      CLEAR lv_fm_name.
    ENDIF.
  ENDIF.

  ls_result-form_name    = lv_form.
  ls_result-package_name = lv_tadir-devclass.
  ls_result-generated_fm = lv_fm_name.

  IF ls_input-confirm IS INITIAL.
    ls_result-dry_run = 'X'.
    ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
    ev_message = |Dry run: { lv_form } would be deleted from package { lv_tadir-devclass } (pass confirm: true)|.
    RETURN.
  ENDIF.

* 1. Directory / content / texts
  CALL FUNCTION 'SSF_DELETE_FORM'
    EXPORTING
      i_formname = lv_form.

* 2. TADIR (wi_test_modus defaults to 'X' and must be switched off explicitly, otherwise it only simulates)
*    WI_TADIR_OBJ_NAME is TADIR-OBJ_NAME (C40); passing TDSFNAME (C30) straight through dumps.
  lv_left = lv_form.
  CALL FUNCTION 'TR_TADIR_INTERFACE'
    EXPORTING
      wi_delete_tadir_entry = 'X'
      wi_test_modus         = ' '
      wi_tadir_pgmid        = 'R3TR'
      wi_tadir_object       = 'SSFO'
      wi_tadir_obj_name     = lv_left
    EXCEPTIONS
      OTHERS                = 1.
  IF sy-subrc <> 0.
    ev_subrc   = 8.
    ev_message = |SmartForm { lv_form } rows were deleted but the TADIR entry could not be removed (sy-subrc={ sy-subrc })|.
    ls_result-deleted = 'X'.
    ls_result-tadir_left = 'X'.
    ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
    RETURN.
  ENDIF.

  CLEAR lv_left.
  SELECT SINGLE obj_name FROM tadir INTO lv_left WHERE pgmid = 'R3TR' AND object = 'SSFO' AND obj_name = lv_form.
  IF sy-subrc = 0 AND lv_left IS NOT INITIAL.
    ls_result-tadir_left = 'X'.
  ENDIF.

  ls_result-deleted = 'X'.
  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.

ENDFUNCTION.
