################################################################################
#  SUB-AGENT FIRST. YOUR SESSION IS THE CONSOLE - KEEP IT CLEAR.               #
#  The main session only dispatches (Agent, SendMessage), monitors and         #
#  reports. Every Bash, PowerShell, Read, Edit, Write, Grep, Glob and          #
#  NotebookEdit call runs inside a sub-agent (background by default) - no      #
#  quick-read exception; a PreToolUse hook denies them in the main thread.     #
################################################################################
