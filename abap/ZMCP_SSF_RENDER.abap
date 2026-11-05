FUNCTION zmcp_ssf_render
  IMPORTING
    VALUE(iv_params)  TYPE string
  EXPORTING
    VALUE(ev_subrc)   TYPE i
    VALUE(ev_message) TYPE string
    VALUE(ev_result)  TYPE string.

*----------------------------------------------------------------------*
* SmartForm render -> PDF, taking the "print parameters + spool + convert to PDF" route
*
* iv_params (JSON):
*   { "form_name": "ZFORM",             SmartForm name (Z/Y)
*     "language": "E",                  output language, defaults to the logon language
*     "device": "LP01",                 print device, defaults to user master data, last resort LP01
*     "values": { "IV_WERKS": "1000" }  form interface parameters by name (scalar / structure / table all work)
*   }
*
* Why not GETOTF: in that mode SAP only accepts the default device from user master data - passing one raises
* SSFCOMPOSER/016 "Parameter DEVICE = LOCL is not allowed", omitting it raises SSFCOMPOSER/010.
* This version uses real print parameters instead: output with a device goes into the spool (TDIMMED empty, so no paper),
* CONVERT_OTFSPOOLJOB_2_PDF converts to PDF -> source request and PDF request are both deleted, nothing left behind.
*----------------------------------------------------------------------*

  DATA: BEGIN OF ls_input,
          form_name TYPE string,   " SmartForm name
          language  TYPE string,   " language (1 character)
          device    TYPE string,   " print device
          values    TYPE string,   " interface parameters as JSON (object)
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          form_name    TYPE string,   " SmartForm name
          language     TYPE string,   " language actually used
          generated_fm TYPE string,   " generated function module name
          device       TYPE string,   " print device actually used (empty = user master data)
          otf_count    TYPE i,        " number of OTF lines
          pdf_size     TYPE i,        " PDF size in bytes
          defaults     TYPE string,   " required parameters not passed, sent as empty values
          otf_text     TYPE string,   " OTF text (one entry per line, separated by \n)
          pdf_base64   TYPE string,   " PDF (base64)
        END OF ls_result.

  DATA: lv_form      TYPE tdsfname,
        lv_lang      TYPE sy-langu,
        lv_device    TYPE rspopname,
        lv_fm_name   TYPE rs38l_fnam,
        lv_type      TYPE string,
        lv_name      TYPE string,
        lv_message   TYPE string,
        lv_detail    TYPE string,
        lv_msgtxt    TYPE string,
        lv_subrc     TYPE i,
        lv_member    TYPE string,
        lv_otf_line  TYPE string,
        lv_pdf_len   TYPE i,
        lv_pdf       TYPE xstring,
        lt_param     TYPE abap_func_parmbind_tab,
        ls_param     TYPE abap_func_parmbind,
        lt_exc       TYPE abap_func_excpbind_tab,
        ls_exc       TYPE abap_func_excpbind,
        ls_control   TYPE ssfctrlop,
        ls_output    TYPE ssfcompop,
        lv_user_set  TYPE tdbool,
        ls_out       TYPE ssfcrescl,
        lt_otf       TYPE tsfotf,
        lt_lines     TYPE TABLE OF tline WITH DEFAULT KEY, " CONVERT_OTF is a FORM interface, it rejects an empty-key table
        lt_interface TYPE tsfiopar,
        lt_components TYPE abap_component_tab,
        lt_given     TYPE HASHED TABLE OF string WITH UNIQUE KEY table_line,
        lo_values    TYPE REF TO data,
        lo_param     TYPE REF TO data,
        lo_out       TYPE REF TO data,
        lo_ctrl      TYPE REF TO data,
        lo_bool      TYPE REF TO data,
        lo_outopt    TYPE REF TO data,
        lo_struct    TYPE REF TO cl_abap_structdescr,
        lo_line      TYPE REF TO cl_abap_datadescr,
        lo_table     TYPE REF TO cl_abap_tabledescr,
        lo_form      TYPE REF TO cl_ssf_fb_smart_form,
        lx_root      TYPE REF TO cx_root,
        lx_convert   TYPE REF TO cx_root.

  FIELD-SYMBOLS: <lv_given> TYPE any,
                 <lv_value> TYPE any,
                 <ls_otf>   TYPE any,
                 <lv_otf>   TYPE any,
                 <ls_line>  LIKE LINE OF lt_lines,
                 <ls_iface> LIKE LINE OF lt_interface,
                 <ls_comp>  TYPE abap_componentdescr,
                 <ls_exc>   TYPE abap_func_excpbind.

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

  lv_lang = sy-langu.
  IF ls_input-language IS NOT INITIAL.
    lv_lang = ls_input-language(1).
  ENDIF.

* The device is not mandatory: under GETOTF SAP only accepts the device from user master data, passing one raises SSFCOMPOSER/016.
* When the caller really wants a specific one, it only goes into OUTPUT_OPTIONS-TDDEST (the print parameter side).
  lv_device = ls_input-device.

* Generated function module name (the form must be active).
  CALL FUNCTION 'SSF_FUNCTION_MODULE_NAME'
    EXPORTING
      formname           = lv_form
    IMPORTING
      fm_name            = lv_fm_name
    EXCEPTIONS
      no_form            = 1
      no_function_module = 2
      OTHERS             = 3.
  IF sy-subrc <> 0.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } has no generated function module (activate it first)|.
    RETURN.
  ENDIF.

* Form interface: gives the parameters passed in by the caller their types.
  TRY.
      CREATE OBJECT lo_form.
      CALL METHOD lo_form->load
        EXPORTING
          im_formname = lv_form
          im_active   = 'X'.
      lt_interface[] = lo_form->interface.
    CATCH cx_root INTO lx_root.
      ev_subrc   = 4.
      ev_message = |SmartForm { lv_form }: interface could not be read ({ lx_root->get_text( ) })|.
      RETURN.
  ENDTRY.

* Print parameters, following that CSDN write-up: GETOTF keeps the output in memory,
* TDIMMED / TDDELETE / TDNOPREV are all set, USER_SETTINGS stays 'X'.
* Measured on this system: a DEVICE (control parameter or TDDEST) raises SSFCOMPOSER/016, omitting it works.
  ls_control-no_dialog = 'X'.
  ls_control-getotf    = 'X'.
  ls_control-langu     = lv_lang.

  ls_output-tdimmed    = 'X'.
  ls_output-tddelete   = 'X'.
  ls_output-tdnoprev   = 'X'.
  ls_output-tdnewid    = 'X'.
  IF lv_device IS NOT INITIAL.
    ls_output-tddest = lv_device.
  ENDIF.

  GET REFERENCE OF ls_control INTO lo_ctrl.
  ls_param-name  = 'CONTROL_PARAMETERS'.
  ls_param-kind  = abap_func_exporting.
  ls_param-value = lo_ctrl.
  INSERT ls_param INTO TABLE lt_param[].

  GET REFERENCE OF ls_output INTO lo_outopt.
  ls_param-name  = 'OUTPUT_OPTIONS'.
  ls_param-kind  = abap_func_exporting.
  ls_param-value = lo_outopt.
  INSERT ls_param INTO TABLE lt_param[].

  GET REFERENCE OF ls_out INTO lo_out.
  ls_param-name  = 'JOB_OUTPUT_INFO'.
  ls_param-kind  = abap_func_importing.
  ls_param-value = lo_out.
  INSERT ls_param INTO TABLE lt_param[].

* USER_SETTINGS stays 'X' as in the blog post (take the print parameters from user master data).
  lv_user_set = 'X'.
  GET REFERENCE OF lv_user_set INTO lo_bool.
  ls_param-name  = 'USER_SETTINGS'.
  ls_param-kind  = abap_func_exporting.
  ls_param-value = lo_bool.
  INSERT ls_param INTO TABLE lt_param[].

* Parameters from the caller: create data objects with the type declared in the interface, values take one JSON round trip (same code for scalar / structure / table).
  IF ls_input-values IS NOT INITIAL AND ls_input-values <> '{}'.
    TRY.
        lo_values = /ui2/cl_json=>generate( json = ls_input-values ).
        lo_struct ?= cl_abap_typedescr=>describe_by_data_ref( lo_values ).
        lt_components[] = lo_struct->get_components( ).
      CATCH cx_root INTO lx_root.
        ev_subrc   = 4.
        ev_message = |VALUES must be a JSON object ({ lx_root->get_text( ) })|.
        RETURN.
    ENDTRY.

    LOOP AT lt_components[] ASSIGNING <ls_comp>.
      lv_name = <ls_comp>-name.
      TRANSLATE lv_name TO UPPER CASE.

      UNASSIGN <ls_iface>.
      READ TABLE lt_interface[] ASSIGNING <ls_iface> WITH KEY name = lv_name.
      IF <ls_iface> IS NOT ASSIGNED.
        ev_subrc   = 4.
        ev_message = |{ lv_name } is not a parameter of SmartForm { lv_form }|.
        RETURN.
      ENDIF.

      CLEAR ls_param.
      ls_param-name = lv_name.
      lv_type = <ls_iface>-typename.
      IF lv_type IS INITIAL.
        lv_type = 'STRING'.
      ENDIF.

      TRY.
          IF <ls_iface>-iotype = 'T'.
            lo_line ?= cl_abap_typedescr=>describe_by_name( lv_type ).
            lo_table = cl_abap_tabledescr=>create( p_line_type = lo_line ).
            CREATE DATA lo_param TYPE HANDLE lo_table.
            ls_param-kind = abap_func_tables.
          ELSE.
            CREATE DATA lo_param TYPE (lv_type).
            IF <ls_iface>-iotype = 'E'.
              ls_param-kind = abap_func_importing.
            ELSE.
              ls_param-kind = abap_func_exporting.
            ENDIF.
          ENDIF.
        CATCH cx_root.
*         A LIKE <some field> declaration cannot be created from its type name, so fall back to character (most interface parameters are C/D domains).
          CREATE DATA lo_param TYPE string.
          ls_param-kind = abap_func_exporting.
      ENDTRY.

      ASSIGN lo_values->*(<ls_comp>-name) TO <lv_given>.
      ASSIGN lo_param->* TO <lv_value>.
      TRY.
          lv_member = /ui2/cl_json=>serialize( data = <lv_given> ).
          /ui2/cl_json=>deserialize( EXPORTING json = lv_member CHANGING data = <lv_value> ).
        CATCH cx_root INTO lx_convert.
          ev_subrc   = 4.
          ev_message = |{ lv_name }: value does not fit { lv_type } ({ lx_convert->get_text( ) })|.
          RETURN.
      ENDTRY.

      ls_param-value = lo_param.
      INSERT ls_param INTO TABLE lt_param[].
      INSERT lv_name INTO TABLE lt_given[].
    ENDLOOP.
  ENDIF.

* Required parameters that were not passed are sent as empty values and named in the result.
  LOOP AT lt_interface[] ASSIGNING <ls_iface> WHERE iotype <> 'E' AND iotype <> 'X' AND optional IS INITIAL.
    lv_name = <ls_iface>-name.
    READ TABLE lt_given[] WITH TABLE KEY table_line = lv_name TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      CONTINUE.
    ENDIF.

    lv_type = <ls_iface>-typename.
    IF lv_type IS INITIAL.
      lv_type = 'STRING'.
    ENDIF.
    CLEAR ls_param.
    ls_param-name = lv_name.
    TRY.
        IF <ls_iface>-iotype = 'T'.
          lo_line ?= cl_abap_typedescr=>describe_by_name( lv_type ).
          lo_table = cl_abap_tabledescr=>create( p_line_type = lo_line ).
          CREATE DATA lo_param TYPE HANDLE lo_table.
          ls_param-kind = abap_func_tables.
        ELSE.
          CREATE DATA lo_param TYPE (lv_type).
          ls_param-kind = abap_func_exporting.
        ENDIF.
      CATCH cx_root.
        CONTINUE.
    ENDTRY.
    ls_param-value = lo_param.
    INSERT ls_param INTO TABLE lt_param[].
    IF ls_result-defaults IS INITIAL.
      ls_result-defaults = lv_name.
    ELSE.
      ls_result-defaults = |{ ls_result-defaults },{ lv_name }|.
    ENDIF.
  ENDLOOP.

* The generated FM ships these four non-class exceptions; binding them yields a name instead of a dump.
  CLEAR ls_exc.
  ls_exc-name  = 'FORMATTING_ERROR'.
  ls_exc-value = 1.
  INSERT ls_exc INTO TABLE lt_exc[].
  ls_exc-name  = 'INTERNAL_ERROR'.
  ls_exc-value = 2.
  INSERT ls_exc INTO TABLE lt_exc[].
  ls_exc-name  = 'SEND_ERROR'.
  ls_exc-value = 3.
  INSERT ls_exc INTO TABLE lt_exc[].
  ls_exc-name  = 'USER_CANCELED'.
  ls_exc-value = 4.
  INSERT ls_exc INTO TABLE lt_exc[].

  TRY.
      CALL FUNCTION lv_fm_name
        PARAMETER-TABLE lt_param[]
        EXCEPTION-TABLE lt_exc[].
    CATCH cx_root INTO lx_root.
      ev_subrc   = 8.
      ev_message = |{ lv_fm_name } could not be called: { lx_root->get_text( ) }|.
      RETURN.
    ENDTRY.

  IF sy-subrc <> 0.
    CLEAR: lv_message, lv_detail.
    lv_subrc = sy-subrc.
    LOOP AT lt_exc[] ASSIGNING <ls_exc> WHERE value = lv_subrc.
      lv_message = <ls_exc>-name.
      EXIT.
    ENDLOOP.
*   The generated FM usually MESSAGEs something before raising; SY-MSG* is still set, so turn it into text and pass it back.
    IF sy-msgid IS NOT INITIAL AND sy-msgno IS NOT INITIAL.
      MESSAGE ID sy-msgid TYPE 'I' NUMBER sy-msgno INTO lv_msgtxt
              WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4.
      lv_detail = |{ sy-msgid }/{ sy-msgno }: { lv_msgtxt }|.
    ENDIF.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } raised { lv_message } (sy-subrc={ lv_subrc })| &&
                 COND string( WHEN lv_detail IS INITIAL THEN || ELSE | [{ lv_detail }]| ).
    RETURN.
  ENDIF.

* The OTF sits in JOB_OUTPUT_INFO (GETOTF); return it to the caller as text and also use it for the PDF.
  lt_otf[] = ls_out-otfdata.
  IF lt_otf[] IS INITIAL.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } produced no OTF output|.
    RETURN.
  ENDIF.

  LOOP AT lt_otf[] ASSIGNING <ls_otf>.
    ASSIGN COMPONENT 'TDLINE' OF STRUCTURE <ls_otf> TO <lv_otf>.
    IF sy-subrc = 0.
      lv_otf_line = <lv_otf>.
    ELSE.
      CLEAR lv_otf_line.
    ENDIF.
    IF ls_result-otf_text IS INITIAL.
      ls_result-otf_text = lv_otf_line.
    ELSE.
      ls_result-otf_text = |{ ls_result-otf_text }\n{ lv_otf_line }|.
    ENDIF.
  ENDLOOP.
  ls_result-otf_count = lines( lt_otf[] ).

* OTF -> PDF (standard FM, same as the blog post: FORMAT = 'PDF').
  TRY.
      CALL FUNCTION 'CONVERT_OTF'
        EXPORTING
          format       = 'PDF'
        IMPORTING
          bin_filesize = lv_pdf_len
          bin_file     = lv_pdf
        TABLES
          otf          = lt_otf[]
          lines        = lt_lines[]
        EXCEPTIONS
          OTHERS       = 1.
    CATCH cx_root INTO lx_convert.
      CLEAR: lv_pdf, lv_pdf_len.
  ENDTRY.

* When bin_file is empty, rebuild the binary from LINES (the blog post uses LINES as well).
  IF lv_pdf IS INITIAL AND lt_lines[] IS NOT INITIAL.
    LOOP AT lt_lines[] ASSIGNING <ls_line>.
      lv_pdf = lv_pdf && <ls_line>-tdline.
    ENDLOOP.
    lv_pdf_len = xstrlen( lv_pdf ).
  ENDIF.

  IF lv_pdf IS INITIAL.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } produced OTF but the PDF conversion returned nothing|.
    RETURN.
  ENDIF.

  ls_result-form_name    = lv_form.
  ls_result-language     = lv_lang.
  ls_result-device       = lv_device.
  ls_result-generated_fm = lv_fm_name.
  ls_result-pdf_size     = lv_pdf_len.
  ls_result-pdf_base64   = cl_web_http_utility=>encode_x_base64( lv_pdf ).

  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.
ENDFUNCTION.
