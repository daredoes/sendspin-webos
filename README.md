# Sendspin Cinema Player for LG webOS 🎬🎵

A beautiful, minimalistic, cinema-inspired web player for **Music Assistant**. This application is designed specifically for LG webOS TVs, providing a stunning visual experience while streaming audio to your TV.

## ✨ Features
* **Cinema Aesthetic:** Dark, immersive background with a glowing progress bar.
* **Dynamic Colors:** Automatically extracts the dominant color from the album art and adapts the UI accent color (powered by Vibrant.js).
* **Real-time Sync:** Shows exact playback progress, track duration, and media controls.
* **Plug & Play:** Easy setup right from the TV screen (just enter your Music Assistant IP and preferred Player Name).
* **Screensaver Friendly:** UI automatically hides after 5 seconds of inactivity for a clean, distraction-free look.

## 🚀 Installation Guide

Since this is an unofficial webOS application, you will need to install it via LG Developer Mode.

### Prerequisites
1.  Install the **Developer Mode** app from the LG Content Store on your TV and log in.
2.  Enable **Dev Mode Status** and **Key Server** in the app.
3.  Take note of the TV's IP address and Passphrase.
4.  Ensure you have [webOS CLI tools (ares-cli)](https://webostv.developer.lge.com/develop/tools/cli-introduction) installed on your computer.

### Packing & Installing
1.  Clone this repository or download the files into a folder (e.g., `lg-player`).
2.  Open your terminal and package the app without minification:
    ```bash
    ares-package --no-minify /path/to/lg-player
    ```
3.  Set up your TV connection:
    ```bash
    ares-setup-device
    # Follow the prompts to add your TV (IP, port 9922, user 'prisoner')
    ares-novacom --device <YOUR_DEVICE_NAME> --getkey
    # Enter the Passphrase from your TV screen
    ```
4.  Install the generated `.ipk` file:
    ```bash
    ares-install --device <YOUR_DEVICE_NAME> com.sendspin.cinema_1.0.0_all.ipk
    ```

## ⚠️ Important Note for Music Assistant
When you first launch the app on your TV, enter your MA server IP and the Player Name. 
Because Music Assistant often hides newly discovered custom web players by default:
1. Open your Music Assistant web interface.
2. Go to **Settings** -> **Players**.
3. Find the player name you just entered (check the *Disabled* or *Hidden* list if it's not visible).
4. Click on the player settings and **uncheck "Hide this player in the user interface"**.
5. Your TV is now ready to play music!

## ☕ Support the Project
If this app made your home theater experience better, consider buying me a coffee! 

[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/TVOJ_USERNAME)
