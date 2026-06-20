cmake_minimum_required(VERSION 3.10)
project(sendspin_audio_helper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(audio-helper audio_helper.c)

# Prefer pkg-config when the sysroot provides it (webOS NDK sysroot does).
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(PULSE QUIET libpulse-simple)
endif()

if(PULSE_FOUND)
    target_include_directories(audio-helper PRIVATE ${PULSE_INCLUDE_DIRS})
    target_link_directories(audio-helper PRIVATE ${PULSE_LIBRARY_DIRS})
    target_link_libraries(audio-helper PRIVATE ${PULSE_LIBRARIES})
else()
    # Fallback: link the libs by name (cross sysroot without .pc files).
    target_link_libraries(audio-helper PRIVATE pulse-simple pulse)
endif()

target_link_libraries(audio-helper PRIVATE m pthread)

install(TARGETS audio-helper RUNTIME DESTINATION bin)
