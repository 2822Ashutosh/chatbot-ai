import openpyxl
import os
import json

file_path = r'c:\Users\KIIT\Downloads\Adobe BOT SDR.xlsx'
wb = openpyxl.load_workbook(file_path)
ws = wb['Sheet1']

rows = []
for row in ws.iter_rows(values_only=True):
    rows.append([str(c) if c is not None else '' for c in row])

with open(r'c:\Users\KIIT\Downloads\Chatbot Ai\adobe_sdr_output.json', 'w') as f:
    json.dump(rows, f, indent=2)
