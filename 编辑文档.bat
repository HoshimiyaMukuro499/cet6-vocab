@echo off
rem 双击这里，用 Word 打开单词本
for %%f in ("%~dp0public\*.docx") do start "" "%%f"
