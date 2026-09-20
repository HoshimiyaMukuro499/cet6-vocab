@echo off
rem 双击这里，用 Word 打开单词本
rem 注意：这里必须写死文件名，不能用 *.docx 通配符。
rem Word 打开文档时会在同目录生成 ~$单词本.docx 锁文件，通配符会把它一并匹配到。
start "" "%~dp0public\单词本.docx"
