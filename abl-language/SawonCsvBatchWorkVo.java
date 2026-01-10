package com.batch.vo;

import lombok.Data;
import lombok.AllArgsConstructor;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.math.BigDecimal;
import java.text.DecimalFormat;

@AllArgsConstructor
@NoArgsConstructor
@Data
public class SawonCsvBatchWorkVo {
    private DeptFile deptFile;
    private TaxFile taxFile;
    private CsvFile csvFile;
    private String wsEmpno;
    private String wsAddr;
    private BigDecimal wsSalary;
    private String wsSalaryTxt;
    private String cursorEofFlag = "N";
    private String wsSalaryEdited;
    private String wsTaxEdited;
    private String wsTaxTxt;

    public void setWsSalaryEdited(String s) {
        if (s == null || s.isBlank()) {
            this.wsSalaryEdited = "";
            return;
        }
        
        BigDecimal val = new BigDecimal(s.trim());
        DecimalFormat df = new DecimalFormat("#######.00");
        this.wsSalaryEdited = df.format(val);
    }
    
    public String getWsSalaryEdited() {
        return wsSalaryEdited;
    }
    

    public void setWsTaxEdited(String s) {
        if (s == null || s.isBlank()) {
            this.wsTaxEdited = "";
            return;
        }
        
        BigDecimal val = new BigDecimal(s.trim());
        DecimalFormat df = new DecimalFormat("#######.00");
        this.wsTaxEdited = df.format(val);
    }
    
    public String getWsTaxEdited() {
        return wsTaxEdited;
    }
    
        
    private boolean isCursorEof(String param) {
        String target = (param != null) ? param : cursorEofFlag;
        return "Y".equals(target);
    }
        
    private boolean isCursorNotEof(String param) {
        String target = (param != null) ? param : cursorEofFlag;
        return "N".equals(target);
    }
}
