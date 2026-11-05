FUNCTION zmcp_adt_textpool
  IMPORTING
    VALUE(iv_action) TYPE string
    VALUE(iv_program) TYPE syrepid
    VALUE(iv_language) TYPE sylangu DEFAULT sy-langu
    VALUE(iv_textpool_json) TYPE string OPTIONAL
  EXPORTING
    VALUE(ev_result) TYPE string
    VALUE(ev_subrc) TYPE i
    VALUE(ev_message) TYPE string.



* Fixed 8-place header of selection texts inside the pool (add it yourself when the first character is not D)
  CONSTANTS: BEGIN OF cs_sel,
               prefix TYPE string VALUE `        `,   " header made of 8 blanks
               len    TYPE i VALUE 8,                  " header length in characters
             END OF cs_sel.

* Row structure on the JSON side (ENTRY as string, to avoid CHAR 132 round-trip truncation)
  TYPES: BEGIN OF ty_out,
           id     TYPE c LENGTH 1,   " row type: I/S/R/H
           key    TYPE c LENGTH 8,   " key: symbol number or parameter name
           entry  TYPE string,       " text content
           length TYPE i,            " text length in characters
         END OF ty_out.

  DATA: lt_textpool TYPE TABLE OF textpool WITH EMPTY KEY,   " text pool rows to write
        lt_out      TYPE TABLE OF ty_out WITH EMPTY KEY,     " JSON deserialization buffer
        ls_row      TYPE textpool,                           " work area before writing
        ls_out      TYPE ty_out,                             " single-row JSON buffer
        lv_action   TYPE string,                             " action: READ / WRITE
        lv_language TYPE sylangu,                            " target language
        lv_entry    TYPE string,                             " text after the header was added
        lv_first    TYPE string,                             " first character of the text
        lv_head     TYPE string,                             " existing 8-place header
        lv_len      TYPE i.                                  " text length

  FIELD-SYMBOLS: <fs_textpool> TYPE textpool,   " iterates over the text pool
                 <fs_out>      TYPE ty_out.     " iterates over the JSON rows

  CLEAR: ev_result, ev_subrc, ev_message.

  lv_action = iv_action.
  TRANSLATE lv_action TO UPPER CASE.

  lv_language = iv_language.
  IF lv_language IS INITIAL.
    lv_language = sy-langu.
  ENDIF.

  CASE lv_action.

    WHEN 'READ' OR 'READ_RAW'.
      READ TEXTPOOL iv_program
        INTO lt_textpool
        LANGUAGE lv_language.
      IF sy-subrc <> 0.
        CLEAR lt_textpool.
      ENDIF.

*     READ: strip the 8-place header of ID='S', so the caller gets the visible text
      CLEAR lt_out.
      LOOP AT lt_textpool[] ASSIGNING <fs_textpool>.
        CLEAR ls_out.
        ls_out-id     = <fs_textpool>-id.
        ls_out-key    = <fs_textpool>-key.
        ls_out-entry  = <fs_textpool>-entry.
        ls_out-length = <fs_textpool>-length.

        IF lv_action = 'READ' AND ls_out-id = 'S' AND ls_out-entry IS NOT INITIAL.
          lv_entry = ls_out-entry.
          lv_len   = strlen( lv_entry ).
          IF lv_len >= 1.
            lv_first = substring( val = lv_entry off = 0 len = 1 ).
            IF lv_first <> 'D' AND lv_len > cs_sel-len.
              ls_out-entry  = substring(
                val = lv_entry
                off = cs_sel-len
                len = lv_len - cs_sel-len ).
              ls_out-length = lv_len - cs_sel-len.
            ENDIF.
          ENDIF.
        ENDIF.

        APPEND ls_out TO lt_out[].
      ENDLOOP.

      TRY.
          ev_result = /ui2/cl_json=>serialize(
            data        = lt_out
            compress    = abap_false
            pretty_name = /ui2/cl_json=>pretty_mode-none ).
        CATCH cx_root INTO DATA(lx_read).
          ev_subrc   = 8.
          ev_message = |JSON serialize failed: { lx_read->get_text( ) }|.
          RETURN.
      ENDTRY.

    WHEN 'WRITE'.
      IF iv_textpool_json IS INITIAL.
        ev_subrc   = 4.
        ev_message = 'IV_TEXTPOOL_JSON is required for action WRITE'.
        RETURN.
      ENDIF.

*     WRITE: deserialize into the string-entry structure first, then add the header and cap the length row by row
      CLEAR lt_out.
      TRY.
          /ui2/cl_json=>deserialize(
            EXPORTING json = iv_textpool_json
            CHANGING  data = lt_out ).
        CATCH cx_root INTO DATA(lx_write).
          ev_subrc   = 8.
          ev_message = |JSON deserialize failed: { lx_write->get_text( ) }|.
          RETURN.
      ENDTRY.

      CLEAR lt_textpool.
      LOOP AT lt_out[] ASSIGNING <fs_out>.
        CLEAR ls_row.
        ls_row-id  = <fs_out>-id.
        ls_row-key = <fs_out>-key.

        IF <fs_out>-id = 'S' AND <fs_out>-entry IS NOT INITIAL.
          lv_entry = <fs_out>-entry.
          lv_len   = strlen( lv_entry ).
          IF lv_len >= 1.
            lv_first = substring( val = lv_entry off = 0 len = 1 ).
            IF lv_first <> 'D'.
*             When the value is already in "header + text" form, strip it first, otherwise the header piles up
              IF lv_len > cs_sel-len.
                lv_head = substring(
                  val = lv_entry
                  off = 0
                  len = cs_sel-len ).
                IF lv_head = cs_sel-prefix.
                  lv_entry = substring(
                    val = lv_entry
                    off = cs_sel-len
                    len = lv_len - cs_sel-len ).
                ENDIF.
              ENDIF.
              lv_entry = cs_sel-prefix && lv_entry.
            ENDIF.
          ENDIF.
          ls_row-entry  = lv_entry.
          ls_row-length = strlen( lv_entry ).
        ELSE.
          ls_row-entry  = <fs_out>-entry.
          ls_row-length = strlen( <fs_out>-entry ).
        ENDIF.

        APPEND ls_row TO lt_textpool[].
      ENDLOOP.

*     Write straight into the active pool (same effect as RS_CUA_INTERNAL_WRITE) => no separate activation by the caller
      INSERT TEXTPOOL iv_program
        FROM lt_textpool
        LANGUAGE lv_language
        STATE 'A'.
      IF sy-subrc <> 0.
        ev_subrc   = sy-subrc.
        ev_message = |INSERT TEXTPOOL failed for { iv_program } ({ lv_language }) subrc={ sy-subrc }|.
        RETURN.
      ENDIF.

      ev_result = '{"written":true}'.

    WHEN OTHERS.
      ev_subrc   = 4.
      ev_message = |Unknown action '{ iv_action }'|.

  ENDCASE.

ENDFUNCTION.