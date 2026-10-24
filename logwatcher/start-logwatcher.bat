@echo off
rem Uruchamia skrypt logow Tarkova w widocznym oknie (podglad, co robi).
rem W tle, bez okna, uruchamia go logwatcher-ukryty.vbs (to jest w autostarcie Windowsa).
cd /d "%~dp0"
title Tarkov Tracker - skrypt logow
node logwatcher.js
pause
