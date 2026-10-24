' Uruchamia skrypt logow Tarkova w tle, bez okna konsoli.
' Skrot do tego pliku lezy w autostarcie Windowsa (shell:startup).
' Co robi skrypt, widac w pliku logwatcher.log obok.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\logwatcher.js""", 0, False
