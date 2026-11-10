; Copyright (c) 2026 Ling Stack contributors
; SPDX-License-Identifier: MIT
; Windows shell operations implemented using NSIS's licensed System plug-in.
!ifndef LING_SHELL_INCLUDED
!define LING_SHELL_INCLUDED
!include LogicLib.nsh
!include Win\COM.nsh
!include Win\Propkey.nsh

!macro Ling_SetShortcutAUMI LINK APP_ID
  System::Store S
  System::Call 'ole32::CoInitializeEx(p 0, i 2)i.r9'
  StrCpy $0 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    StrCpy $1 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${LINK}",2).r8'
      ${If} $8 >= 0
        StrCpy $2 0
        ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r2)'
        ${If} $2 P<> 0
          System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r3'
          System::Alloc ${SYSSIZEOF_PROPVARIANT}
          Pop $4
          System::Call '*(&w${NSIS_MAX_STRLEN} "${APP_ID}")p.r5'
          ${If} $3 P<> 0
          ${AndIf} $4 P<> 0
          ${AndIf} $5 P<> 0
            ; x86 Unicode installer: PROPVARIANT is 16 bytes; VT_LPWSTR owns
            ; no memory here. SetValue copies it before buffers are released.
            System::Call '*$4(&i2 ${VT_LPWSTR}, &i6 0, p r5, &i4 0)'
            ${IPropertyStore::SetValue} $2 '($3,$4).r8'
              ${If} $8 >= 0
                ${IPropertyStore::Commit} $2 '().r8'
                ${If} $8 >= 0
                  ${IPersistFile::Save} $1 '("${LINK}",1).r8'
                ${EndIf}
              ${EndIf}
          ${EndIf}
          System::Free $5
          System::Free $4
          System::Free $3
          ${IUnknown::Release} $2 ""
        ${EndIf}
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  ${If} $9 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  System::Store L
!macroend

!macro Ling_RemoveAppDestinations APP_ID
  System::Store S
  System::Call 'ole32::CoInitializeEx(p 0, i 2)i.r9'
  StrCpy $0 0
  System::Call 'ole32::CoCreateInstance(g "{86C14003-4D6B-4EF3-A7B4-0506663B2E68}",p 0,i 1,g "{12337D35-94C6-48A0-BCE7-6A9C69D4D600}",*p.r0)i.r8'
  ${If} $0 P<> 0
    System::Call '$0->3(w "${APP_ID}")i.r8'
    ${If} $8 >= 0
      System::Call '$0->5()i.r8'
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  StrCpy $0 0
  System::Call 'ole32::CoCreateInstance(g "{77F10CF0-3DB5-4966-B520-B7C54FD35ED6}",p 0,i 1,g "{6332DEBF-87B5-4670-90C0-5E57B408A49E}",*p.r0)i.r8'
  ${If} $0 P<> 0
    System::Call '$0->10(w "${APP_ID}")i.r8'
    ${IUnknown::Release} $0 ""
  ${EndIf}
  ${If} $9 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  System::Store L
!macroend

!macro Ling_UnpinShortcut LINK
  System::Store S
  System::Call 'ole32::CoInitializeEx(p 0, i 2)i.r9'
  StrCpy $0 0
  System::Call 'shell32::SHCreateItemFromParsingName(w "${LINK}",p 0,g "{43826D1E-E718-42EE-BC55-A1E261C37BFE}",*p.r0)i.r8'
  ${If} $0 P<> 0
    StrCpy $1 0
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_StartMenuPin} ${IID_IStartMenuPinnedList} r1 ""
    ${If} $1 P<> 0
      ${IStartMenuPinnedList::RemoveFromList} $1 '($0).r8'
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  ${If} $9 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  System::Store L
!macroend
!endif
