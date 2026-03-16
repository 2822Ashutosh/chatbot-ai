import openpyxl
import sys
import os

file_path = r'c:\Users\KIIT\Downloads\SDR (1).xlsx'

try:
    wb = openpyxl.load_workbook(file_path)
    ws = wb['SDR']
    
    print(f"Sheet: {ws.title}")
    
    # Print rows 1 to 15 with index
    print("--- Rows 1-15 ---")
    for i, row in enumerate(ws.iter_rows(min_row=1, max_row=15, values_only=True)):
        row_data = [str(cell) if cell is not None else '' for cell in row]
        print(f"Row {i+1}: {row_data}")

except Exception as e:
    print(f"Error: {e}")
