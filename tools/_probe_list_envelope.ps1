$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeCredRead {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
    public static string ReadGeneric(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize <= 0) return "";
            return Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize / 2);
        } finally { CredFree(ptr); }
    }
}
"@
$token = [NativeCredRead]::ReadGeneric("asset-library-token:provider-e943eb7e-0d7b-4399-a653-5b06b52f0f84.com.infinitecanvas.desktop")
if ([string]::IsNullOrWhiteSpace($token)) { throw "no-token" }
$env:ASSET_LIBRARY_TOKEN = $token
node "C:\Users\bp180\Desktop\无限画布\tools\_probe_list_envelope.mjs"
