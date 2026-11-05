FUNCTION zmcp_ssf_content
  IMPORTING
    VALUE(iv_params)  TYPE string
  EXPORTING
    VALUE(ev_subrc)   TYPE i
    VALUE(ev_message) TYPE string
    VALUE(ev_result)  TYPE string.

*----------------------------------------------------------------------*
* SmartForm read (read-only)
*
* iv_params (JSON):
*   { "part": "FORM",  "form_name": "ZFORM" }   form XML (logon language)
*   { "part": "STYLE", "name": "ZSTYLE" }       style -> CSS
*   { "part": "TEXTS", "form_name": "ZFORM" }   form text lines
*
* ev_result (JSON):
*   FORM  { "part":"FORM",  "form_name":..., "language":..., "xml":... }
*   STYLE { "part":"STYLE", "name":..., "css":..., "fmttype":... }
*   TEXTS { "part":"TEXTS", "form_name":..., "language":..., "count":n, "lines":[...] }
*
* No base64: both sides are our own code, so XML/CSS travel as plain strings, one conversion less that could go wrong silently.
*
* FB_CONVERT_FORM_TO_XML reads the texts by sy-langu internally, hence the returned language tells the
* caller which language it got; the XML carries <MASTERLANG>, so the caller reads the master language from the XML.
*----------------------------------------------------------------------*

  TYPES: BEGIN OF ty_text_line,
           txtype TYPE string,   " text type (FORM = form text)
           line   TYPE string,   " line number (starts at 1, string to keep the JSON simple)
           text   TYPE string,   " line text
         END OF ty_text_line.
  TYPES: ty_text_lines TYPE TABLE OF ty_text_line WITH EMPTY KEY.

  DATA: BEGIN OF ls_input,
          part      TYPE string,   " FORM / STYLE / TEXTS
          form_name TYPE string,   " SmartForm name
          name      TYPE string,   " style name for the STYLE part
        END OF ls_input.

  DATA: BEGIN OF ls_result,
          part      TYPE string,        " echoed part name
          form_name TYPE string,        " SmartForm name
          name      TYPE string,        " style name (STYLE part)
          language  TYPE string,        " language used to read the texts (sy-langu)
          xml       TYPE string,        " Form Builder XML of the FORM part
          css       TYPE string,        " CSS of the STYLE part
          fmttype   TYPE string,        " style media type (SFHTTPTYPE)
          count     TYPE i,             " number of text lines
          lines     TYPE ty_text_lines, " text lines
        END OF ls_result.

  DATA: lv_xstring TYPE xstring,
        lt_css     TYPE tsfstbody,
        lv_css     TYPE string,
        lv_fmttype TYPE sfhttptype,
        lv_fmtlen  TYPE i,
        lv_form    TYPE string,
        lv_style   TYPE string,
        lo_conv    TYPE REF TO cl_abap_conv_in_ce,
        lt_texts   TYPE TABLE OF tline,
        ls_line    TYPE ty_text_line,
        lv_index   TYPE i.

  FIELD-SYMBOLS: <ls_text> TYPE tline,
                 <ls_css>  TYPE string.

  DATA: lx_root TYPE REF TO cx_root.

  CLEAR: ev_subrc, ev_message, ev_result, ls_result.

  /ui2/cl_json=>deserialize(
    EXPORTING json = iv_params
    CHANGING  data = ls_input ).

  TRANSLATE ls_input-part TO UPPER CASE.
  lv_form = ls_input-form_name.
  TRANSLATE lv_form TO UPPER CASE.
  CASE ls_input-part.

    WHEN 'FORM'.
      IF lv_form IS INITIAL.
        ev_subrc   = 4.
        ev_message = 'FORM_NAME is required'.
        RETURN.
      ENDIF.

      TRY.
          CALL FUNCTION 'FB_CONVERT_FORM_TO_XML'
            EXPORTING
              i_formname      = lv_form
            IMPORTING
              e_xml           = lv_xstring
            EXCEPTIONS
              no_name         = 1
              no_form         = 2
              no_active_source = 3
              conversion_error = 4
              illegal_formtype = 5
              generation_error = 6
              OTHERS          = 7.
        CATCH cx_root INTO lx_root.
          ev_subrc   = 4.
          ev_message = |SmartForm { lv_form }: { lx_root->get_text( ) }|.
          RETURN.
      ENDTRY.

      IF sy-subrc <> 0.
        ev_subrc   = 4.
        CASE sy-subrc.
          WHEN 2.
            ev_message = |SmartForm { lv_form } does not exist|.
          WHEN 3.
            ev_message = |SmartForm { lv_form } has no active version|.
          WHEN OTHERS.
            ev_message = |SmartForm { lv_form } could not be converted to XML (FB_CONVERT_FORM_TO_XML sy-subrc={ sy-subrc })|.
        ENDCASE.
        RETURN.
      ENDIF.

      IF lv_xstring IS INITIAL.
        ev_subrc   = 4.
        ev_message = |SmartForm { lv_form } returned an empty XML|.
        RETURN.
      ENDIF.

      lo_conv = cl_abap_conv_in_ce=>create( input = lv_xstring encoding = 'UTF-8' ).
      lo_conv->read( IMPORTING data = ls_result-xml ).

      ls_result-part      = 'FORM'.
      ls_result-form_name = lv_form.
      ls_result-language  = sy-langu.

    WHEN 'STYLE'.
      lv_style = ls_input-name.
      IF lv_style IS INITIAL.
        ev_subrc   = 4.
        ev_message = 'NAME is required for part STYLE'.
        RETURN.
      ENDIF.

      TRY.
          CALL FUNCTION 'SSF_CONVERT_STYLE_TO_CSS'
            EXPORTING
              stylename  = lv_style
            IMPORTING
              fmtcontent = lt_css
              fmttype    = lv_fmttype
              fmtlength  = lv_fmtlen.
        CATCH cx_root.
          ev_subrc   = 4.
          ev_message = |SmartStyle { lv_style } could not be converted to CSS|.
          RETURN.
      ENDTRY.

*     fmtcontent is a table of "CSS lines"; join it into one string before returning it.
      CLEAR lv_css.
      LOOP AT lt_css[] ASSIGNING <ls_css>.
        IF lv_css IS INITIAL.
          lv_css = <ls_css>.
        ELSE.
          lv_css = |{ lv_css }\n{ <ls_css> }|.
        ENDIF.
      ENDLOOP.
      ls_result-css = lv_css.

      ls_result-part    = 'STYLE'.
      ls_result-name    = lv_style.
      ls_result-fmttype = lv_fmttype.

    WHEN 'TEXTS'.
      IF lv_form IS INITIAL.
        ev_subrc   = 4.
        ev_message = 'FORM_NAME is required for part TEXTS'.
        RETURN.
      ENDIF.

*     Form texts are stored under text object FORM (STXFTXT).
      REFRESH lt_texts[].
      CALL FUNCTION 'READ_TEXT'
        EXPORTING
          id       = 'FORM'
          language = sy-langu
          name     = lv_form
          object   = 'FORM'
        TABLES
          lines    = lt_texts[]
        EXCEPTIONS
          OTHERS   = 4.
      IF sy-subrc <> 0.
        ev_subrc   = 4.
        ev_message = |SmartForm { lv_form } has no text lines in { sy-langu }|.
        RETURN.
      ENDIF.

      lv_index = 0.
      LOOP AT lt_texts[] ASSIGNING <ls_text>.
        lv_index = lv_index + 1.
        CLEAR ls_line.
        ls_line-txtype = 'FORM'.
        ls_line-line   = lv_index.
        ls_line-text   = <ls_text>-tdline.
        APPEND ls_line TO ls_result-lines[].
      ENDLOOP.

      ls_result-part      = 'TEXTS'.
      ls_result-form_name = lv_form.
      ls_result-language  = sy-langu.
      ls_result-count     = lv_index.

    WHEN OTHERS.
      ev_subrc   = 4.
      ev_message = |Unknown part '{ ls_input-part }' (FORM / STYLE / TEXTS)|.
      RETURN.

  ENDCASE.

  ev_result  = /ui2/cl_json=>serialize( data = ls_result ).
  ev_message = 'OK'.

ENDFUNCTION.
