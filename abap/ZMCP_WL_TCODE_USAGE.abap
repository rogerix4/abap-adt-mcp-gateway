FUNCTION zmcp_wl_tcode_usage
  IMPORTING
    VALUE(iv_tcodes)   TYPE string
    VALUE(iv_months)   TYPE i DEFAULT 12
    VALUE(iv_rfcdest)  TYPE string OPTIONAL
  EXPORTING
    VALUE(ev_result)   TYPE string
    VALUE(ev_coverage) TYPE i
    VALUE(ev_sysid)    TYPE string
    VALUE(ev_subrc)    TYPE i
    VALUE(ev_message)  TYPE string.

  DATA: lt_tcode  TYPE TABLE OF tcode WITH EMPTY KEY,        " requested transaction codes
        lt_comp   TYPE TABLE OF swnchostname WITH EMPTY KEY, " component names holding aggregates
        lt_ut     TYPE TABLE OF swncaggusertcode WITH DEFAULT KEY, " one month of user/tcode aggregates
        lt_found  TYPE HASHED TABLE OF tcode WITH UNIQUE KEY table_line, " transactions seen in window
        lv_tc     TYPE tcode,                                " one entry id as transaction code
        lv_raw    TYPE string,                               " upper-cased input
        lv_item   TYPE string,                               " one json pair
        lv_json   TYPE string,                               " result json
        lv_cnt    TYPE i,                                    " pairs written
        lv_mon    TYPE i,                                    " months clamped
        lv_cov    TYPE i,                                    " months with workload data
        lv_y      TYPE i,                                    " year of window start
        lv_m      TYPE i,                                    " month of window start
        lv_cy     TYPE i,                                    " current year
        lv_cm     TYPE i,                                    " current month
        lv_idx    TYPE i,                                    " month counter
        lv_start_c TYPE c LENGTH 8,                          " window start as char
        lv_period TYPE swncdatum,                            " period start of one month
        lv_has    TYPE c LENGTH 1.                           " month had workload data
  FIELD-SYMBOLS: <fs_tcode> TYPE tcode,                      " one requested transaction
                 <fs_comp>  TYPE swnchostname,               " one component
                 <fs_ut>    TYPE swncaggusertcode.           " one aggregate row

  CLEAR: ev_result, ev_coverage, ev_sysid, ev_subrc, ev_message.

  ev_sysid = sy-sysid.

  IF iv_rfcdest IS NOT INITIAL.
    ev_subrc = 8.
    ev_message = `IV_RFCDEST is not supported by this bridge`.
    ev_result = `{}`.
    RETURN.
  ENDIF.

  lv_raw = iv_tcodes.
  TRANSLATE lv_raw TO UPPER CASE.
  SPLIT lv_raw AT ',' INTO TABLE lt_tcode.
  DELETE lt_tcode WHERE table_line IS INITIAL.
  IF lt_tcode IS INITIAL.
    ev_subrc = 8.
    ev_message = `IV_TCODES is empty`.
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

  SELECT DISTINCT component FROM swncmoni
    INTO TABLE lt_comp
    WHERE periodtype = 'M'
      AND periodstrt >= lv_start_c.

  lv_cy = lv_y.
  lv_cm = lv_m.
  lv_idx = 0.
  WHILE lv_idx < lv_mon.
    CLEAR lv_period.
    WRITE lv_cy TO lv_period(4).
    WRITE lv_cm TO lv_period+4(2).
    lv_period+6(2) = '01'.
    CLEAR lv_has.
    LOOP AT lt_comp[] ASSIGNING <fs_comp>.
      CLEAR lt_ut.
      CALL FUNCTION 'SWNC_COLLECTOR_GET_AGGREGATES'
        EXPORTING
          component     = <fs_comp>
          periodtype    = 'M'
          periodstrt    = lv_period
        TABLES
          usertcode     = lt_ut
        EXCEPTIONS
          no_data_found = 1
          OTHERS        = 2.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_has = 'X'.
      LOOP AT lt_ut[] ASSIGNING <fs_ut>.
        CLEAR lv_tc.
        lv_tc = <fs_ut>-entry_id.
        INSERT lv_tc INTO TABLE lt_found.
      ENDLOOP.
    ENDLOOP.
    IF lv_has = 'X'.
      lv_cov = lv_cov + 1.
    ENDIF.
    lv_idx = lv_idx + 1.
    lv_cm = lv_cm + 1.
    IF lv_cm > 12.
      lv_cm = 1.
      lv_cy = lv_cy + 1.
    ENDIF.
  ENDWHILE.

  lv_json = `{`.
  LOOP AT lt_tcode[] ASSIGNING <fs_tcode>.
    IF lv_cnt > 0.
      lv_item = `,`.
    ELSE.
      CLEAR lv_item.
    ENDIF.
    READ TABLE lt_found[] WITH KEY table_line = <fs_tcode> TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      lv_item = lv_item && `"` && <fs_tcode> && `":true`.
    ELSE.
      lv_item = lv_item && `"` && <fs_tcode> && `":false`.
    ENDIF.
    lv_json = lv_json && lv_item.
    lv_cnt = lv_cnt + 1.
  ENDLOOP.
  lv_json = lv_json && `}`.

  ev_result = lv_json.
  ev_coverage = lv_cov.
  IF lv_cov = 0.
    ev_subrc = 4.
    ev_message = `no workload data in the requested window`.
  ELSE.
    ev_subrc = 0.
    ev_message = `OK`.
  ENDIF.
ENDFUNCTION.
