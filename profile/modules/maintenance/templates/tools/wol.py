"""Wake the backup machine with a Wake-on-LAN magic packet and wait for ssh.

Usage: wol.py [--wait 120]
Sends the packet for {wol_mac} to the local broadcast address, then polls
`ssh {backup_target} true` until it answers or the wait runs out.
"""
import socket
import subprocess
import sys
import time

MAC = "{wol_mac}"


def packet(mac):
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError("a MAC address has 6 bytes")
    return b"\xff" * 6 + raw * 16


def main(argv):
    wait = int(argv[argv.index("--wait") + 1]) if "--wait" in argv else 120
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.sendto(packet(MAC), ("255.255.255.255", 9))
    s.close()
    end = time.time() + wait
    while time.time() < end:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=5", "{backup_target}", "true"], capture_output=True)
        if r.returncode == 0:
            print("awake")
            return 0
        time.sleep(5)
    print("FAIL no ssh answer within " + str(wait) + " s")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
