cmake_minimum_required(VERSION 3.20)
project(LensLinkVirtualCam LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Provide path to Windows SDK DirectShow BaseClasses (strmbase.lib + streams.h)
set(DIRECTSHOW_BASECLASSES_DIR "" CACHE PATH "Path to DirectShow BaseClasses directory")

add_library(LensLinkVirtualCam SHARED
    LensLinkVirtualCam.cpp
    LensLinkVirtualCam.h
    LensLinkVirtualCam.def
)

set_target_properties(LensLinkVirtualCam PROPERTIES
    SUFFIX ".ax"
    PREFIX ""
)

if(DIRECTSHOW_BASECLASSES_DIR)
    target_include_directories(LensLinkVirtualCam PRIVATE "${DIRECTSHOW_BASECLASSES_DIR}")
    target_link_directories(LensLinkVirtualCam PRIVATE "${DIRECTSHOW_BASECLASSES_DIR}/x64/Release")
endif()

target_link_libraries(LensLinkVirtualCam PRIVATE
    strmbase
    winmm
    ole32
    oleaut32
    uuid
    strmiids
    quartz
)
