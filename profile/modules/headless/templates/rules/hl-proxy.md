- THE LOOPBACK ROUTE CONTRACT. In split mode every background run reaches the
  second account through a proxy you run on a loopback address and port. The spawn
  helper checks that the address is loopback, pinned and answering before each run,
  and refuses otherwise.
