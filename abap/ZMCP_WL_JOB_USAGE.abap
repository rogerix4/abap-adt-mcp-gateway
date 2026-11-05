FUNCTION zmcp_wl_job_usage
  IMPORTING
    VALUE(iv_programs) TYPE string
    VALUE(iv_months)   TYPE i DEFAULT 12
  EXPORTING
    VALUE(ev_result)   TYPE string
    VALUE(ev_oldest)   TYPE string
    VALUE(ev_subrc)    TYPE i
    VALUE(ev_message)  TYPE string.

  TYPES: BEGIN OF ty_job,
           jobname   TYPE tbtco-jobname,     " job name
           status    TYPE tbtco-status,      " job status
           sdlstrtdt TYPE tbtco-sdlstrtdt,   " scheduled start date
         END OF ty_job.

  TYPES: BEGIN OF ty_step,
           jobname  TYPE tbtcp-jobname,      " job name
           progname TYPE tbtcp-progname,     " report name
         END OF ty_step.

  DATA: lt_prog    TYPE TABLE OF progname WITH EMPTY KEY,   " requested program names
        lt_co      TYPE TABLE OF ty_job WITH EMPTY KEY,     " candidate job headers
        lt_cp      TYPE TABLE OF ty_step WITH EMPTY KEY,    " job steps
        lt_used    TYPE HASHED TABLE OF progname WITH UNIQUE KEY table_line,   " programs found in steps
        lv_raw     TYPE string,                             " upper-cased input
        lv_item    TYPE string,                             " one json pair
        lv_json    TYPE string,                             " result json
        lv_cnt     TYPE i,                                  " pairs written
        lv_mon     TYPE i,                                  " months clamped
        lv_y       TYPE i,                                  " year of window start
        lv_m       TYPE i,                                  " month of window start
        lv_start   TYPE d,                                  " window start date
        lv_start_c TYPE c LENGTH 8,                         " window start as char
        lv_old     TYPE d,                                  " oldest job still kept
        lv_old_c   TYPE c LENGTH 8.                         " oldest job as char
  FIELD-SYMBOLS: <fs_prog> TYPE progname,                   " one requested program
                 <fs_cp>   TYPE ty_step.                    " one job step

  CLEAR: ev_result, ev_oldest, ev_subrc, ev_message.

  lv_raw = iv_programs.
  TRANSLATE lv_raw TO UPPER CASE.
  SPLIT lv_raw AT ',' INTO TABLE lt_prog.
  DELETE lt_prog WHERE table_line IS INITIAL.
  IF lt_prog IS INITIAL.
    ev_subrc = 8.
    ev_message = `IV_PROGRAMS is empty`.
    ev_result = `{}`.
    RETURN.
  ENDIF.

  lv_mon = iv_months.
  IF lv_mon < 1.
    lv_mon = 12.
  ENDIF.
  IF lv_mon > 36.
    lv_mon = 36.
  ENDIF.

  lv_y = sy-datum(4).
  lv_m = sy-datum+4(2).
  lv_m = lv_m - lv_mon + 1.
  WHILE lv_m <= 0.
    lv_m = lv_m + 12.
    lv_y = lv_y - 1.
  ENDWHILE.
  WRITE lv_y TO lv_start_c(4).
  WRITE lv_m TO lv_start_c+4(2).
  lv_start_c+6(2) = '01'.
  lv_start = lv_start_c.

  SELECT jobname status sdlstrtdt FROM tbtco
    INTO TABLE lt_co
    WHERE sdlstrtdt >= lv_start
       OR status IN ( 'R', 'S', 'A' ).
  IF sy-subrc = 0.
    DELETE lt_co WHERE status = 'P'.
  ENDIF.

  IF lt_co IS NOT INITIAL.
    SELECT jobname progname FROM tbtcp
      INTO TABLE lt_cp
      FOR ALL ENTRIES IN lt_co
      WHERE jobname = lt_co-jobname.
  ENDIF.

  LOOP AT lt_cp[] ASSIGNING <fs_cp>.
    INSERT <fs_cp>-progname INTO TABLE lt_used.
  ENDLOOP.

  lv_json = `{`.
  LOOP AT lt_prog[] ASSIGNING <fs_prog>.
    IF lv_cnt > 0.
      lv_item = `,`.
    ELSE.
      CLEAR lv_item.
    ENDIF.
    READ TABLE lt_used[] WITH KEY table_line = <fs_prog> TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      lv_item = lv_item && `"` && <fs_prog> && `":true`.
    ELSE.
      lv_item = lv_item && `"` && <fs_prog> && `":false`.
    ENDIF.
    lv_json = lv_json && lv_item.
    lv_cnt = lv_cnt + 1.
  ENDLOOP.
  lv_json = lv_json && `}`.

  SELECT MIN( sdlstrtdt ) FROM tbtco INTO lv_old WHERE sdlstrtdt >= '19900101'.
  lv_old_c = lv_old.

  ev_result = lv_json.
  ev_oldest = lv_old_c.
  ev_subrc = 0.
  ev_message = `OK`.
ENDFUNCTION.
