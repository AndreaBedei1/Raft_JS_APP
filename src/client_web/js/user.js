$(document).ready(function () {
    let userCookie = document.cookie.split("user=")[1];

    loadUserAuctions(userCookie);
    loadParticipations(userCookie);

    $("#logout").on("click", function() {
        $.ajax({
            type: "POST",
            url: "/logoutuser",
            data: "{}",
            processData: false,
            contentType: "application/json"
        })
        .done(function (data, success, response) {
            console.log(success);
            if(success!=="success"){
                addAlert("alert","alert-danger","Errore nella disconnesione.","");
            } else {
                window.location.href="/login";
            }
        })
        .fail(function (response) {
            console.log(response);
        });
    });
});

function loadUserAuctions(user){
    $.ajax({
        type: "POST",
        url: "/getUserAuctions",
        data: JSON.stringify({user: user}),
        processData: false,
        contentType: "application/json"
    })
    .done(function (data, success, response) {
        for (const auction of data) {
            let trElem = document.createElement("tr");

            trElem.append(`
                <td scope="col">${auction.objName}</th>
                <td scope="col">${new Date(auction.openingDate).toLocaleString()}</th>
                <td scope="col">${auction.closingDate ? new Date(auction.closingDate).toLocaleString() : "Asta aperta"}</th>
                <td scope="col">${auction.startingPrice}</th>
                <td scope="col">${auction.highestBidValue ?? ""}</th>
            `);

            let btnVisitAuction = document.createElement("button");
            btnVisitAuction.classList.add("btn", "btn-primary");
            btnVisitAuction.addEventListener("click", () => {
                $.ajax({
                    type: "GET",
                    url: "/auction?id=" + auction.auctionId,
                });
            });

            let tdElem = document.createElement("td");
            tdElem.append(btnVisitAuction);
            trElem.append(tdElem);

            $("#my_ast").append(trElem);
        }
    })
    .fail(function (response) {
        console.log(response);
    });

}

function loadParticipations(user){    
    $.ajax({
        type: "POST",
        url: "/getUserParticipations",
        data: JSON.stringify({user: user}),
        processData: false,
        contentType: "application/json"
    })
    .done(function (data, success, response) {
        for (const auction of data) {
            let trElem = document.createElement("tr");

            trElem.append(`
                <td scope="col">${auction.objName}</th>
                <td scope="col">${new Date(auction.openingDate).toLocaleString()}</th>
                <td scope="col">${auction.closingDate ? new Date(auction.closingDate).toLocaleString() : "Asta aperta"}</th>
                <td scope="col">${auction.startingPrice}</th>
                <td scope="col">${auction.highestBidValue ?? ""}</th>
            `);

            let btnVisitAuction = document.createElement("button");
            btnVisitAuction.classList.add("btn", "btn-primary");
            btnVisitAuction.addEventListener("click", () => {
                $.ajax({
                    type: "GET",
                    url: "/auction?id=" + auction.auctionId,
                });
            });

            let tdElem = document.createElement("td");
            tdElem.append(btnVisitAuction);
            trElem.append(tdElem);
            
            $("#my_part").append(trElem);
        }
    })
    .fail(function (response) {
        console.log(response);
    });
}