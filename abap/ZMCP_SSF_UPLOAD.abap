FUNCTION zmcp_ssf_upload
  IMPORTING
    VALUE(iv_params)  TYPE string
  EXPORTING
    VALUE(ev_subrc)   TYPE i
    VALUE(ev_message) TYPE string
    VALUE(ev_result)  TYPE string.

*----------------------------------------------------------------------*
* SmartForm create / overwrite (XML -> SmartForm)
*
* iv_params (JSON):
*   { "form_name": "ZFORM",   SmartForm name (Z/Y)
*     "xml": "<...>",         Form Builder XML (the format of SMARTFORMS > Utilities > Download,
*                             i.e. the very file ZMCP_SSF_CONTENT part=FORM returns)
*     "language": "E",        master language, defaults to the logon language
*     "overwrite": true,      allow replacing an existing form, default false
*     "activate": true }      write the active version and generate the function module, default true
*
* Goes through CL_SSF_FB_SMART_FORM: XML_UPLOAD builds the model -> CHECK -> ENQUEUE -> STORE -> DEQUEUE.
*
* Local ($...) packages only: a SmartForm under a transport needs a transport request, and this
* version does not wire set_correction_request, so transport_request is refused explicitly instead of silently writing to $TMP.
*----------------------------------------------------------------------*

  DATA: BEGIN OF ls_input,
          form_name  TYPE string,   " SmartForm name
          xml        TYPE string,   " Form Builder XML
          language   TYPE string,   " master language (1 character)
          overwrite  TYPE string,   " 'X' = overwrite an existing form
          activate   TYPE string,   " 'X' = write the active version
          transport_request TYPE string, " transport request (not supported here)
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          form_name     TYPE string,  " SmartForm name
          language      TYPE string,  " master language used for the write
          stored        TYPE string,  " 'X' = stored
          active        TYPE string,  " 'X' = active version written
          package_name  TYPE string,  " package it landed in (TADIR)
          generated_fm  TYPE string,  " generated function module (only after activation)
        END OF ls_result.

  DATA: lv_form      TYPE tdsfname,
        lv_lang      TYPE sy-langu,
        lv_want_active TYPE tdsfflag, " 'X' = store the active version (runs CHECK as well)
        lv_xml       TYPE string,   " XML to parse, after escaping
        lv_tadir     TYPE tadir,
        lv_tadir_name TYPE tadir-obj_name, " TADIR stores C40, so TDSFNAME (C30) cannot be passed straight through
        lv_fmnumb    TYPE tdfmnumb,
        lv_fmnumb_t  TYPE tdfmnumb,
        lv_fm_name   TYPE rs38l_fnam,
        lv_active    TYPE tdsfflag,   " 'X' only once the active version could be read back
        lv_parse     TYPE i,
        lo_ixml      TYPE REF TO if_ixml,
        lo_sfactory  TYPE REF TO if_ixml_stream_factory,
        lo_stream    TYPE REF TO if_ixml_istream,
        lo_parser    TYPE REF TO if_ixml_parser,
        lo_err       TYPE REF TO if_ixml_parse_error,
        lo_doc       TYPE REF TO if_ixml_document,
        lo_node      TYPE REF TO if_ixml_node,
        lo_sform     TYPE REF TO cl_ssf_fb_smart_form,
        lx_check     TYPE REF TO cx_ssf_fb_check,
        lx_ssf       TYPE REF TO cx_ssf_fb.

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
  IF ls_input-xml IS INITIAL.
    ev_subrc   = 4.
    ev_message = 'XML is required'.
    RETURN.
  ENDIF.
  IF ls_input-transport_request IS NOT INITIAL.
    ev_subrc   = 4.
    ev_message = 'transport_request is not supported by this bridge yet: it writes local ($…) forms only'.
    RETURN.
  ENDIF.

  lv_lang = sy-langu.
  IF ls_input-language IS NOT INITIAL.
    lv_lang = ls_input-language(1).
  ENDIF.

* activate is on by default; only an explicit 'N' stores a non-active version (and skips CHECK).
* Letters instead of blanks: a blank cannot be told apart from "not passed" in JSON, and overwrite relies on the empty string meaning "not passed".
  lv_want_active = 'X'.
  IF ls_input-activate = 'N'.
    CLEAR lv_want_active.
  ENDIF.

* Already there? Stop right here unless overwrite is on, so someone else's form is not replaced.
  SELECT SINGLE * FROM tadir INTO lv_tadir
    WHERE pgmid = 'R3TR' AND object = 'SSFO' AND obj_name = lv_form.
  IF sy-subrc = 0 AND ls_input-overwrite IS INITIAL.
    ev_subrc   = 4.
    ev_message = |SmartForm { lv_form } already exists (pass overwrite: true to replace it)|.
    RETURN.
  ENDIF.

  TRY.
*     Form Builder XML has two kinds of & in it: text placeholders &FIELD& (a bare &, illegal in XML)
*     and the valid entities &amp; &lt; &gt; &quot; &apos;. Files downloaded from SMARTFORMS look the same,
*     so escaping the whole document breaks the entities (the first version really returned Field "&APOS;X&APOS;" is unknown).
*     Approach: swap the entities to sentinels -> escape the remaining bare & to &amp; -> restore the sentinels.
      lv_xml = ls_input-xml.
      REPLACE ALL OCCURRENCES OF '&apos;' IN lv_xml WITH '@MCP-E1@'.
      REPLACE ALL OCCURRENCES OF '&quot;' IN lv_xml WITH '@MCP-E2@'.
      REPLACE ALL OCCURRENCES OF '&lt;'   IN lv_xml WITH '@MCP-E3@'.
      REPLACE ALL OCCURRENCES OF '&gt;'   IN lv_xml WITH '@MCP-E4@'.
      REPLACE ALL OCCURRENCES OF '&amp;'  IN lv_xml WITH '@MCP-E5@'.
      REPLACE ALL OCCURRENCES OF '&'      IN lv_xml WITH '&amp;'.
      REPLACE ALL OCCURRENCES OF '@MCP-E1@' IN lv_xml WITH '&apos;'.
      REPLACE ALL OCCURRENCES OF '@MCP-E2@' IN lv_xml WITH '&quot;'.
      REPLACE ALL OCCURRENCES OF '@MCP-E3@' IN lv_xml WITH '&lt;'.
      REPLACE ALL OCCURRENCES OF '@MCP-E4@' IN lv_xml WITH '&gt;'.
      REPLACE ALL OCCURRENCES OF '@MCP-E5@' IN lv_xml WITH '&amp;'.

      lo_ixml     = cl_ixml=>create( ).
      lo_doc      = lo_ixml->create_document( ).
      lo_sfactory = lo_ixml->create_stream_factory( ).
      lo_stream   = lo_sfactory->create_istream_string( lv_xml ).
*     CREATE_PARSER lives on IF_IXML (not on the stream factory) and needs three parameters.
      lo_parser   = lo_ixml->create_parser( stream_factory = lo_sfactory
                                            istream        = lo_stream
                                            document       = lo_doc ).
      lv_parse    = lo_parser->parse( ).

      IF lv_parse <> 0.
        ev_subrc = 4.
        IF lo_parser->num_errors( ) > 0.
          lo_err     = lo_parser->get_error( 0 ).
          ev_message = |XML could not be parsed: { lo_err->get_reason( ) } (line { lo_err->get_line( ) },| &&
                       | column { lo_err->get_column( ) }, received { strlen( lv_xml ) } chars)|.
        ELSE.
          ev_message = |XML could not be parsed (received { strlen( lv_xml ) } chars)|.
        ENDIF.
        RETURN.
      ENDIF.

      lo_node = lo_doc->get_root_element( ).
      IF lo_node IS NOT BOUND.
        ev_subrc   = 4.
        ev_message = 'XML could not be parsed (no root element)'.
        RETURN.
      ENDIF.

      CREATE OBJECT lo_sform.
      CALL METHOD lo_sform->xml_upload
        EXPORTING
          dom      = lo_node
          formname = lv_form
          language = lv_lang
        CHANGING
          sform    = lo_sform.

*     A new form lands in $TMP: the XML carries the source form's DEVCLASS (e.g. ZSD),
*     STORE would ask for a transport request for it, nobody can answer that under RFC, and it
*     ends up as "Screen output without connection to user". Overwriting an existing form keeps its package.
      IF lv_tadir IS INITIAL.
        lo_sform->header-devclass = '$TMP'.
      ENDIF.

      IF lv_want_active IS NOT INITIAL.
        CALL METHOD lo_sform->check( ).
      ENDIF.
    CATCH cx_ssf_fb_check INTO lx_check.
*     CHECK keeps every problem in ERROR_TABLE; get_text( ) alone leaves only
*     "Error occurred during check", which gives the caller nothing to act on, so the table is returned as is.
      ev_subrc   = 4.
      ev_message = |SmartForm { lv_form } failed the check|.
      ev_result  = /ui2/cl_json=>serialize( data = lx_check->error_table compress = abap_true ).
      RETURN.
    CATCH cx_root.
      ev_subrc   = 4.
      ev_message = |SmartForm { lv_form }: XML upload failed|.
      RETURN.
  ENDTRY.

  TRY.
*     STORE calls SET_CORRECTION_REQUEST -> RS_CORR_INSERT itself; while the object has no TADIR
*     entry it raises the dialog "Enter object directory entry" (shown in the logon language); nobody can press it
*     under RFC, so it dumps straight into "Screen output without connection to user" (measured
*     stack: STORE -> SET_CORRECTION_REQUEST -> RS_CORR_INSERT -> TRINT_TADIR_POPUP -> CALL SCREEN 100).
*     So create the $TMP TADIR entry first, and STORE stops asking.
      IF lv_tadir IS INITIAL.
        lv_tadir_name = lv_form.
        CALL FUNCTION 'TR_TADIR_INTERFACE'
          EXPORTING
            wi_test_modus       = ' '
            wi_tadir_pgmid      = 'R3TR'
            wi_tadir_object     = 'SSFO'
            wi_tadir_obj_name   = lv_tadir_name
            wi_tadir_devclass   = '$TMP'
            wi_tadir_masterlang = lv_lang
          EXCEPTIONS
            OTHERS              = 1.
        IF sy-subrc <> 0.
          ev_subrc   = 4.
          ev_message = |SmartForm { lv_form }: TADIR entry could not be created| &&
                       | ({ sy-msgid } { sy-msgno }): { sy-msgv1 }{ sy-msgv2 }{ sy-msgv3 }{ sy-msgv4 }|.
          RETURN.
        ENDIF.
      ENDIF.

      CALL METHOD lo_sform->enqueue
        EXPORTING
          formname = lv_form
          mode     = 'MODIFY'.

      CALL METHOD lo_sform->store
        EXPORTING
          im_formname = lv_form
          im_language = lv_lang
          im_active   = lv_want_active.

      CALL METHOD lo_sform->dequeue
        EXPORTING
          formname = lv_form.
    CATCH cx_ssf_fb INTO lx_ssf.
      ev_subrc   = 4.
      ev_message = |SmartForm { lv_form } could not be stored: { lx_ssf->get_text( ) }|.
      RETURN.
  ENDTRY.

* Name of the generated function module: it only exists after activation, reported to the caller for later rendering and debugging.
* Only an unreadable active version means really inactive, so ACTIVE comes from the read-back, not from the input.
  CLEAR: lv_fmnumb, lv_fmnumb_t, lv_active.
  TRY.
      CREATE OBJECT lo_sform.
      CALL METHOD lo_sform->load
        EXPORTING
          im_formname    = lv_form
          im_active      = 'X'
        IMPORTING
          ex_fmnumb      = lv_fmnumb
          ex_fmnumb_test = lv_fmnumb_t.
      lv_active = 'X'.
    CATCH cx_ssf_fb.
      CLEAR: lv_fmnumb, lv_fmnumb_t.
  ENDTRY.

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
    CLEAR lv_fm_name.
  ENDIF.

  SELECT SINGLE devclass FROM tadir INTO ls_result-package_name
    WHERE pgmid = 'R3TR' AND object = 'SSFO' AND obj_name = lv_form.

  ls_result-form_name    = lv_form.
  ls_result-language     = lv_lang.
  ls_result-stored       = 'X'.
  ls_result-active       = lv_active.
  ls_result-generated_fm = lv_fm_name.

  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.

ENDFUNCTION.
