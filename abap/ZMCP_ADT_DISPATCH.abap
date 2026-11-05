FUNCTION zmcp_adt_dispatch
  IMPORTING
    VALUE(iv_action) TYPE string
    VALUE(iv_params) TYPE string
  EXPORTING
    VALUE(ev_subrc) TYPE i
    VALUE(ev_message) TYPE string
    VALUE(ev_result) TYPE string.

*----------------------------------------------------------------------*
* JSON dispatcher for screen / GUI status operations (called by the MCP gateway via SOAP RFC)
* Actions:
*   DYNPRO_INSERT / DYNPRO_READ / DYNPRO_DELETE
*   CUA_FETCH / CUA_WRITE / CUA_DELETE
* Contract:
*   iv_params is a JSON string, ev_result is a JSON string
*   ev_subrc = 0 success / 4 invalid input or action / 8 internal error
*----------------------------------------------------------------------*

  DATA: lv_action TYPE string,      " action name (compared in upper case)
        lv_fm     TYPE rs38l_fnam,                            " target function module to forward to
        lx_root   TYPE REF TO cx_root,                        " catch-all exception
        lx_bad    TYPE REF TO cx_sy_dyn_call_parameter_error. " carries the parameter name on a type error

  CLEAR: ev_subrc, ev_message, ev_result.

  lv_action = iv_action.
  TRANSLATE lv_action TO UPPER CASE.

  IF lv_action IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'IV_ACTION is required'.
    RETURN.
  ENDIF.

  TRY.
      CASE lv_action.

        WHEN 'DYNPRO_INSERT'.
          PERFORM dynpro_insert USING iv_params
                                CHANGING ev_subrc ev_message ev_result.

        WHEN 'DYNPRO_READ'.
          PERFORM dynpro_read USING iv_params
                              CHANGING ev_subrc ev_message ev_result.

        WHEN 'DYNPRO_DELETE'.
          PERFORM dynpro_delete USING iv_params
                                CHANGING ev_subrc ev_message ev_result.

        WHEN 'CUA_FETCH'.
          PERFORM cua_fetch USING iv_params
                            CHANGING ev_subrc ev_message ev_result.

        WHEN 'CUA_WRITE'.
          PERFORM cua_write USING iv_params
                            CHANGING ev_subrc ev_message ev_result.

        WHEN 'CUA_DELETE'.
          PERFORM cua_delete USING iv_params
                             CHANGING ev_subrc ev_message ev_result.

        WHEN 'SSF_CONTENT' OR 'SSF_UPLOAD_XML' OR 'SSF_DELETE_FORM' OR 'SSF_RENDER'.
          CASE lv_action.
            WHEN 'SSF_CONTENT'.
              lv_fm = 'ZMCP_SSF_CONTENT'.
            WHEN 'SSF_UPLOAD_XML'.
              lv_fm = 'ZMCP_SSF_UPLOAD'.
            WHEN 'SSF_RENDER'.
              lv_fm = 'ZMCP_SSF_RENDER'.
            WHEN OTHERS.
              lv_fm = 'ZMCP_SSF_DELETE'.
          ENDCASE.
          CALL FUNCTION lv_fm
            EXPORTING
              iv_params  = iv_params
            IMPORTING
              ev_subrc   = ev_subrc
              ev_message = ev_message
              ev_result  = ev_result
            EXCEPTIONS
              OTHERS     = 1.
          IF sy-subrc <> 0.
            CLEAR ev_result.
            ev_subrc   = 8.
            ev_message = |{ lv_fm } could not be called (sy-subrc={ sy-subrc })|.
          ENDIF.

        WHEN OTHERS.
          ev_subrc   = 4.
          ev_message = |Unknown action '{ iv_action }'|.

      ENDCASE.

    CATCH cx_sy_dyn_call_parameter_error INTO lx_bad.
      ev_subrc   = 8.
      ev_message = |{ lx_bad->get_text( ) } [parameter={ lx_bad->parameter }]|.
    CATCH cx_root INTO lx_root.
      ev_subrc   = 8.
      ev_message = lx_root->get_text( ).
      IF lx_root->previous IS BOUND.
        ev_message = |{ ev_message } <= { lx_root->previous->get_text( ) }|.
      ENDIF.
  ENDTRY.

ENDFUNCTION.

*&---------------------------------------------------------------------*
*& Create screen: JSON -> RPY_DYNPRO_INSERT
*&---------------------------------------------------------------------*
FORM dynpro_insert USING    iv_params  TYPE string
                   CHANGING ev_subrc   TYPE i
                            ev_message TYPE string
                            ev_result  TYPE string.

* Flow logic lines (the JSON only supplies the text lines)
  TYPES: BEGIN OF ty_flow_line,
           line TYPE string,     " one text line of flow logic
         END OF ty_flow_line,
         ty_flow_lines TYPE TABLE OF ty_flow_line WITH EMPTY KEY.

  DATA: BEGIN OF ls_input,
          program     TYPE string,     " program name
          dynpro      TYPE string,     " screen number
          dynpro_data TYPE string,     " JSON string of the screen definition
        END OF ls_input.

  DATA: BEGIN OF ls_dynpro,
          header               TYPE rpy_dyhead,    " screen header
          containers           TYPE dycatt_tab,    " containers
          fields_to_containers TYPE dyfatc_tab,    " fields
          flow_logic           TYPE ty_flow_lines, " flow logic
        END OF ls_dynpro.

  DATA: ls_header  TYPE rpy_dyhead,                          " screen header
        lt_conts   TYPE dycatt_tab,                          " containers (passed as TABLES parameter)
        lt_flds    TYPE dyfatc_tab,                          " fields (passed as TABLES parameter)
        lt_flows   TYPE TABLE OF rpy_dyflow WITH DEFAULT KEY, " flow logic (passed as TABLES parameter)
        ls_flow    TYPE rpy_dyflow,                           " flow logic work area
        lv_program TYPE syrepid,                             " program name (upper case)
        lv_dynpro  TYPE sydynnr.                             " screen number

  FIELD-SYMBOLS: <fs_flow_logic> TYPE ty_flow_line.   " iterates the JSON flow logic lines

  CLEAR: ev_subrc, ev_message, ev_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  lv_dynpro  = ls_input-dynpro.

  IF lv_program IS INITIAL OR lv_dynpro IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM and DYNPRO are required'.
    RETURN.
  ENDIF.

  IF ls_input-dynpro_data IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'DYNPRO_DATA is required'.
    RETURN.
  ENDIF.

  /ui2/cl_json=>deserialize(
    EXPORTING json = ls_input-dynpro_data
    CHANGING  data = ls_dynpro ).

  ls_header = ls_dynpro-header.
  lt_conts  = ls_dynpro-containers.
  lt_flds   = ls_dynpro-fields_to_containers.

* Flow logic: copy the JSON line entries into RPY_DYFLOW row by row
  CLEAR lt_flows.
  LOOP AT ls_dynpro-flow_logic ASSIGNING <fs_flow_logic>.
    CLEAR ls_flow.
    ls_flow-line = <fs_flow_logic>-line.
    APPEND ls_flow TO lt_flows[].
  ENDLOOP.

  CALL FUNCTION 'RPY_DYNPRO_INSERT'
    EXPORTING
      header                = ls_header
      suppress_exist_checks = abap_true
    TABLES
      containers           = lt_conts
      fields_to_containers = lt_flds
      flow_logic           = lt_flows
    EXCEPTIONS
      cancelled              = 1
      already_exists         = 2
      program_not_exists     = 3
      not_executed           = 4
      missing_required_field = 5
      illegal_field_value    = 6
      field_not_allowed      = 7
      not_generated          = 8
      illegal_field_position = 9
      OTHERS                 = 10.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RPY_DYNPRO_INSERT failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

  ev_message = |Screen { lv_program }/{ lv_dynpro } created|.
  ev_result  = '{"created":true}'.

ENDFORM.


*&---------------------------------------------------------------------*
*& Form DYNPRO_READ
*&---------------------------------------------------------------------*
*& Read screen: RPY_DYNPRO_READ -> JSON
*&---------------------------------------------------------------------*
FORM dynpro_read USING    iv_params  TYPE string
                 CHANGING ev_subrc   TYPE i
                          ev_message TYPE string
                          ev_result  TYPE string.

  DATA: BEGIN OF ls_input,
          program TYPE string,   " program name
          dynpro  TYPE string,   " screen number
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          header               TYPE rpy_dyhead,                          " screen header
          containers           TYPE dycatt_tab,                          " containers
          fields_to_containers TYPE dyfatc_tab,                          " fields
          flow_logic           TYPE TABLE OF rpy_dyflow WITH DEFAULT KEY, " flow logic
        END OF ls_result.

  DATA: ls_header  TYPE rpy_dyhead,                          " screen header
        lt_conts   TYPE dycatt_tab,                          " containers (passed as TABLES parameter)
        lt_flds    TYPE dyfatc_tab,                          " fields (passed as TABLES parameter)
        lt_flows   TYPE TABLE OF rpy_dyflow WITH DEFAULT KEY,  " flow logic (passed as TABLES parameter)
        lv_program TYPE syrepid,                             " program name (upper case)
        lv_dynpro  TYPE d020s-dnum.                          " screen number (ANY parameters take flat characters only)

  CLEAR: ev_subrc, ev_message, ev_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  lv_dynpro  = ls_input-dynpro.
  IF lv_program IS INITIAL OR lv_dynpro IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM and DYNPRO are required'.
    RETURN.
  ENDIF.

  CALL FUNCTION 'RPY_DYNPRO_READ'
    EXPORTING
      progname             = lv_program
      dynnr                = lv_dynpro
    IMPORTING
      header               = ls_header
    TABLES
      containers           = lt_conts
      fields_to_containers = lt_flds
      flow_logic           = lt_flows
    EXCEPTIONS
      cancelled        = 1
      not_found        = 2
      permission_error = 3
      OTHERS           = 4.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RPY_DYNPRO_READ failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

  ls_result-header               = ls_header.
  ls_result-containers           = lt_conts.
  ls_result-fields_to_containers = lt_flds.
  ls_result-flow_logic           = lt_flows.
  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.

ENDFORM.


*&---------------------------------------------------------------------*
*& Form DYNPRO_DELETE
*&---------------------------------------------------------------------*
*& Delete screen: RS_DYNPRO_DELETE (popup off, no dialog inside RFC)
*&---------------------------------------------------------------------*
FORM dynpro_delete USING    iv_params  TYPE string
                   CHANGING ev_subrc   TYPE i
                            ev_message TYPE string
                            ev_result  TYPE string.

  DATA: BEGIN OF ls_input,
          program TYPE string,   " program name
          dynpro  TYPE string,   " screen number
        END OF ls_input.

  DATA: lv_program TYPE syrepid,      " program name (upper case)
        lv_dynpro  TYPE d020s-dnum.   " screen number

  CLEAR: ev_subrc, ev_message, ev_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  lv_dynpro  = ls_input-dynpro.
  IF lv_program IS INITIAL OR lv_dynpro IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM and DYNPRO are required'.
    RETURN.
  ENDIF.

  CALL FUNCTION 'RS_DYNPRO_DELETE'
    EXPORTING
      dynnr           = lv_dynpro
      progname        = lv_program
      popup           = abap_false
      suppress_checks = abap_true
      suppress_corr   = abap_false
    EXCEPTIONS
      dynpro_not_found     = 1
      dynpro_not_specified = 2
      not_executed         = 3
      permission_failure   = 4
      OTHERS               = 5.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RS_DYNPRO_DELETE failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

  ev_message = |Screen { lv_program }/{ lv_dynpro } deleted|.
  ev_result  = '{"deleted":true}'.

ENDFORM.


*&---------------------------------------------------------------------*
*& Form CUA_FETCH
*&---------------------------------------------------------------------*
*& Read GUI status: RS_CUA_INTERNAL_FETCH -> JSON (tit uses rsmpe_titt)
*&---------------------------------------------------------------------*
FORM cua_fetch USING    iv_params  TYPE string
               CHANGING ev_subrc   TYPE i
                        ev_message TYPE string
                        ev_result  TYPE string.

  DATA: BEGIN OF ls_input,
          program  TYPE string,   " program name
          language TYPE string,   " language (first character is used)
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          adm TYPE rsmpe_adm,                           " administration information
          sta TYPE TABLE OF rsmpe_stat WITH EMPTY KEY,  " statuses
          fun TYPE TABLE OF rsmpe_funt WITH EMPTY KEY,  " function codes
          men TYPE TABLE OF rsmpe_men WITH EMPTY KEY,   " menus
          mtx TYPE TABLE OF rsmpe_mnlt WITH EMPTY KEY,  " menu texts
          act TYPE TABLE OF rsmpe_act WITH EMPTY KEY,   " function activations
          but TYPE TABLE OF rsmpe_but WITH EMPTY KEY,   " buttons
          pfk TYPE TABLE OF rsmpe_pfk WITH EMPTY KEY,   " function keys
          set TYPE TABLE OF rsmpe_staf WITH EMPTY KEY,  " function key set assignments
          doc TYPE TABLE OF rsmpe_atrt WITH EMPTY KEY,  " attribute texts
          tit TYPE TABLE OF rsmpe_titt WITH EMPTY KEY,  " titles
          biv TYPE TABLE OF rsmpe_buts WITH EMPTY KEY,  " button texts
        END OF ls_result.

  DATA: ls_adm    TYPE rsmpe_adm,  " administration information
        lv_program TYPE syrepid,   " program name (upper case)
        lv_lang   TYPE sy-langu.   " target language

  CLEAR: ev_subrc, ev_message, ev_result, ls_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  IF lv_program IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM is required'.
    RETURN.
  ENDIF.

  lv_lang = sy-langu.
  IF ls_input-language IS NOT INITIAL.
    lv_lang = ls_input-language(1).
  ENDIF.

  CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'
    EXPORTING
      program  = lv_program
      language = lv_lang
      state    = 'A'
    IMPORTING
      adm      = ls_adm
    TABLES
      sta      = ls_result-sta
      fun      = ls_result-fun
      men      = ls_result-men
      mtx      = ls_result-mtx
      act      = ls_result-act
      but      = ls_result-but
      pfk      = ls_result-pfk
      set      = ls_result-set
      doc      = ls_result-doc
      tit      = ls_result-tit
      biv      = ls_result-biv
    EXCEPTIONS
      not_found       = 1
      unknown_version = 2
      OTHERS          = 3.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RS_CUA_INTERNAL_FETCH failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

  ls_result-adm = ls_adm.
  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.

ENDFORM.


*&---------------------------------------------------------------------*
*& Form CUA_WRITE
*&---------------------------------------------------------------------*
*& Write GUI status: RS_CUA_INTERNAL_WRITE (state=A writes the active version, then commit)
*&---------------------------------------------------------------------*
FORM cua_write USING    iv_params  TYPE string
               CHANGING ev_subrc   TYPE i
                        ev_message TYPE string
                        ev_result  TYPE string.

  DATA: BEGIN OF ls_input,
          program  TYPE string,   " program name
          language TYPE string,   " language (first character is used)
          cua_data TYPE string,   " JSON string of the GUI status definition
        END OF ls_input.

  DATA: BEGIN OF ls_cua,
          adm TYPE rsmpe_adm,                           " administration information
          sta TYPE TABLE OF rsmpe_stat WITH EMPTY KEY,  " statuses
          fun TYPE TABLE OF rsmpe_funt WITH EMPTY KEY,  " function codes
          men TYPE TABLE OF rsmpe_men WITH EMPTY KEY,   " menus
          mtx TYPE TABLE OF rsmpe_mnlt WITH EMPTY KEY,  " menu texts
          act TYPE TABLE OF rsmpe_act WITH EMPTY KEY,   " function activations
          but TYPE TABLE OF rsmpe_but WITH EMPTY KEY,   " buttons
          pfk TYPE TABLE OF rsmpe_pfk WITH EMPTY KEY,   " function keys
          set TYPE TABLE OF rsmpe_staf WITH EMPTY KEY,  " function key set assignments
          doc TYPE TABLE OF rsmpe_atrt WITH EMPTY KEY,  " attribute texts
          tit TYPE TABLE OF rsmpe_titt WITH EMPTY KEY,  " titles
          biv TYPE TABLE OF rsmpe_buts WITH EMPTY KEY,  " button texts
        END OF ls_cua.

  DATA: lv_program TYPE syrepid,   " program name (upper case)
        lv_lang    TYPE sy-langu,  " target language
        ls_trkey   TYPE trkey.     " transport object key (mandatory for RS_CUA_INTERNAL_WRITE)

  CLEAR: ev_subrc, ev_message, ev_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  IF lv_program IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM is required'.
    RETURN.
  ENDIF.

  IF ls_input-cua_data IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'CUA_DATA is required'.
    RETURN.
  ENDIF.

  /ui2/cl_json=>deserialize(
    EXPORTING json = ls_input-cua_data
    CHANGING  data = ls_cua ).

  lv_lang = sy-langu.
  IF ls_input-language IS NOT INITIAL.
    lv_lang = ls_input-language(1).
  ENDIF.

  ls_trkey-obj_type = 'PROG'.
  ls_trkey-obj_name = lv_program.
  ls_trkey-sub_type = 'PROG'.
  ls_trkey-sub_name = lv_program.

  CALL FUNCTION 'RS_CUA_INTERNAL_WRITE'
    EXPORTING
      program  = lv_program
      language = lv_lang
      tr_key   = ls_trkey
      adm      = ls_cua-adm
      state    = 'A'
    TABLES
      sta      = ls_cua-sta
      fun      = ls_cua-fun
      men      = ls_cua-men
      mtx      = ls_cua-mtx
      act      = ls_cua-act
      but      = ls_cua-but
      pfk      = ls_cua-pfk
      set      = ls_cua-set
      doc      = ls_cua-doc
      tit      = ls_cua-tit
      biv      = ls_cua-biv
    EXCEPTIONS
      not_found    = 1
      invalid_data = 2
      OTHERS       = 3.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RS_CUA_INTERNAL_WRITE failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

* EXPORT ... TO DATABASE only persists after a commit
  COMMIT WORK AND WAIT.

  ev_message = |CUA written for { lv_program }|.
  ev_result  = '{"written":true}'.

ENDFORM.


*&---------------------------------------------------------------------*
*& Form CUA_DELETE
*&---------------------------------------------------------------------*
*& Delete GUI status: RS_CUA_DELETE (no confirm dialog, empty STATUS deletes all)
*&---------------------------------------------------------------------*
FORM cua_delete USING    iv_params  TYPE string
                CHANGING ev_subrc   TYPE i
                         ev_message TYPE string
                         ev_result  TYPE string.

  DATA: BEGIN OF ls_input,
          program TYPE string,   " program name
          status  TYPE string,   " status name (empty = all)
        END OF ls_input.

  DATA: lv_program TYPE syrepid,       " program name (upper case)
        lv_object  TYPE rsmpe-status.  " status name to delete (* = all)

  CLEAR: ev_subrc, ev_message, ev_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  lv_program = to_upper( ls_input-program ).
  IF lv_program IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'PROGRAM is required'.
    RETURN.
  ENDIF.

  IF ls_input-status IS INITIAL.
    lv_object = '*'.
  ELSE.
    lv_object = to_upper( ls_input-status ).
  ENDIF.

* suppress_checks = 'X': no safety confirmation dialog can pop up inside RFC; the price is no transport recording
  CALL FUNCTION 'RS_CUA_DELETE'
    EXPORTING
      program         = lv_program
      objectname      = lv_object
      suppress_checks = abap_true
    EXCEPTIONS
      failure_del_load      = 1
      not_executed          = 2
      object_not_found      = 3
      object_not_specified  = 4
      permission_failure    = 5
      program_not_found     = 6
      customer_modification = 7
      unknown_version       = 8
      OTHERS                = 9.

  ev_subrc = sy-subrc.
  IF sy-subrc <> 0.
    ev_message = |RS_CUA_DELETE failed (sy-subrc={ sy-subrc })|.
    RETURN.
  ENDIF.

  COMMIT WORK AND WAIT.

  ev_message = |CUA deleted for { lv_program } (object { lv_object })|.
  ev_result  = '{"deleted":true}'.

ENDFORM.
