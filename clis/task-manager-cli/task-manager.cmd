@echo off
rem Double-click: one picker for every repo under oneezy and layerdbiz. Enter creates or repairs the repo's
rem GitHub project (fields, statuses, views, labels, workflows, import) with zero hand steps except Auto-add.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0task-manager.ps1"
