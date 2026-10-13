' Put this file (without ".example") into shell:startup. It starts the restart loop without a window.
Set shell = CreateObject("WScript.Shell")
shell.Run """" & shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\quiet-hub\star-bridge-loop.cmd") & """", 0, False
