; 安装/卸载前结束正在运行的璇玑与常驻的 DSH Web 子进程（进程名同为 Xuanji.exe）。
; 常驻服务用的是安装目录里的 Xuanji.exe，不先结束会锁住文件导致覆盖失败。
!macro customInit
  nsExec::ExecToLog 'taskkill /IM Xuanji.exe /F /T'
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /IM Xuanji.exe /F /T'
!macroend
