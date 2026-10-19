- NEVER TEST A RECONFIGURING SCRIPT ON THE LIVE MACHINE. A script that changes
  system settings is reviewed by reading it, parse-checked (PowerShell with
  powershell.exe 5.1), and run only on its real target or in a throwaway sandbox.
  Stubs are not a safety net: they can miss a real command.
